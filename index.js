#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawn } from "child_process";
import { createReadStream, mkdirSync, writeFileSync, readFileSync, readdirSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import ffmpegPath from "ffmpeg-static";
import OpenAI from "openai";

// ── Config ────────────────────────────────────────────────────────────────────
const TRANSCRIPTS_DIR = process.env.TRANSCRIPTS_DIR || join(homedir(), "meeting-transcripts");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

mkdirSync(TRANSCRIPTS_DIR, { recursive: true });

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

// ── State ─────────────────────────────────────────────────────────────────────
let activeRecording = null;
// activeRecording shape:
// { id, title, startTime, audioPath, ffmpegProcess }

function meetingId() {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function metaPath(id) { return join(TRANSCRIPTS_DIR, `${id}.json`); }
function audioPath(id) { return join(TRANSCRIPTS_DIR, `${id}.wav`); }
function transcriptPath(id) { return join(TRANSCRIPTS_DIR, `${id}.txt`); }

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({ name: "meeting-transcriber", version: "1.0.0" });

// ── Tool: list_audio_devices ──────────────────────────────────────────────────
server.tool(
  "list_audio_devices",
  "List available audio input devices (mic and loopback) on this Windows machine",
  {},
  async () => {
    return new Promise((resolve) => {
      const proc = spawn(ffmpegPath, [
        "-f", "dshow",
        "-list_devices", "true",
        "-i", "dummy"
      ], { windowsHide: true });

      let output = "";
      proc.stderr.on("data", (d) => { output += d.toString(); });
      proc.on("close", () => {
        // Also try wasapi device list
        const wasapiProc = spawn(ffmpegPath, [
          "-f", "wasapi",
          "-list_devices", "true",
          "-i", ""
        ], { windowsHide: true });

        let wasapiOutput = "";
        wasapiProc.stderr.on("data", (d) => { wasapiOutput += d.toString(); });
        wasapiProc.on("close", () => {
          const combined = `=== DirectShow (dshow) devices ===\n${output}\n\n=== WASAPI devices ===\n${wasapiOutput}`;
          resolve({ content: [{ type: "text", text: combined }] });
        });
      });
    });
  }
);

// ── Tool: start_recording ─────────────────────────────────────────────────────
server.tool(
  "start_recording",
  "Start recording audio. Records mic by default. Pass a device name from list_audio_devices for system audio or a specific mic.",
  {
    title: z.string().optional().describe("Optional meeting title (e.g. 'Client call - Acme Corp')"),
    device: z.string().optional().describe("Audio device name from list_audio_devices. Defaults to system default mic."),
    loopback: z.boolean().optional().describe("Capture system audio (what's playing through speakers) instead of mic. Windows WASAPI only."),
  },
  async ({ title, device, loopback }) => {
    if (activeRecording) {
      return {
        content: [{
          type: "text",
          text: `Already recording: "${activeRecording.title || activeRecording.id}" (started ${new Date(activeRecording.startTime).toLocaleTimeString()}). Call stop_and_transcribe first.`
        }]
      };
    }

    if (!openai) {
      return {
        content: [{
          type: "text",
          text: "OPENAI_API_KEY not set. Add it to the MCP server env config in .claude.json to enable transcription."
        }]
      };
    }

    const id = meetingId();
    const wavFile = audioPath(id);

    // Build ffmpeg args for WASAPI capture
    let ffmpegArgs;

    if (loopback) {
      // Capture system audio (what's playing through speakers)
      ffmpegArgs = [
        "-f", "wasapi",
        "-loopback", "1",
        "-i", device || "",
        "-ar", "16000",
        "-ac", "1",
        "-y",
        wavFile
      ];
    } else {
      // Capture mic input
      ffmpegArgs = [
        "-f", "dshow",
        "-i", `audio=${device || "Microphone"}`,
        "-ar", "16000",
        "-ac", "1",
        "-y",
        wavFile
      ];
    }

    const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });

    let startError = "";
    ffmpegProcess.stderr.on("data", (d) => { startError += d.toString(); });

    // Give ffmpeg a moment to fail fast if device not found
    await new Promise(r => setTimeout(r, 1500));

    if (ffmpegProcess.exitCode !== null) {
      return {
        content: [{
          type: "text",
          text: `Failed to start recording.\n\nffmpeg error:\n${startError}\n\nTip: Run list_audio_devices to see available device names, then pass the exact name as the 'device' parameter.`
        }]
      };
    }

    activeRecording = {
      id,
      title: title || null,
      startTime: Date.now(),
      audioPath: wavFile,
      ffmpegProcess
    };

    return {
      content: [{
        type: "text",
        text: `Recording started.\nID: ${id}\nTitle: ${title || "(untitled)"}\nMode: ${loopback ? "System audio (loopback)" : "Microphone"}\nDevice: ${device || "default"}\nSaving to: ${wavFile}\n\nCall stop_and_transcribe when done.`
      }]
    };
  }
);

// ── Tool: stop_and_transcribe ─────────────────────────────────────────────────
server.tool(
  "stop_and_transcribe",
  "Stop the active recording and transcribe it via Whisper. Saves transcript and metadata to disk.",
  {
    title: z.string().optional().describe("Override or set the meeting title"),
    language: z.string().optional().describe("Language hint for Whisper (e.g. 'en', 'es'). Auto-detected if omitted."),
  },
  async ({ title, language }) => {
    if (!activeRecording) {
      return { content: [{ type: "text", text: "No active recording. Start one with start_recording first." }] };
    }

    const { id, title: existingTitle, startTime, audioPath: wavFile, ffmpegProcess } = activeRecording;
    activeRecording = null;

    // Stop ffmpeg gracefully (send 'q' to stdin)
    ffmpegProcess.stdin.write("q");
    ffmpegProcess.stdin.end();

    // Give it up to 3s to finish writing
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        ffmpegProcess.kill("SIGTERM");
        resolve();
      }, 3000);
      ffmpegProcess.on("close", () => { clearTimeout(timeout); resolve(); });
    });

    const durationSec = Math.round((Date.now() - startTime) / 1000);
    const durationStr = `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
    const meetingTitle = title || existingTitle || `Meeting ${id}`;

    if (!existsSync(wavFile)) {
      return { content: [{ type: "text", text: `Audio file not found at ${wavFile}. Recording may have failed to capture audio.` }] };
    }

    // Transcribe via Whisper
    let transcript = "";
    try {
      const response = await openai.audio.transcriptions.create({
        file: createReadStream(wavFile),
        model: "whisper-1",
        ...(language ? { language } : {}),
        response_format: "text"
      });
      transcript = typeof response === "string" ? response : response.text || "";
    } catch (err) {
      return { content: [{ type: "text", text: `Transcription failed: ${err.message}\nAudio saved at: ${wavFile}` }] };
    }

    // Save transcript + metadata
    writeFileSync(transcriptPath(id), transcript, "utf8");
    const meta = {
      id,
      title: meetingTitle,
      date: new Date(startTime).toISOString(),
      duration: durationStr,
      durationSec,
      audioPath: wavFile,
      transcriptPath: transcriptPath(id),
      wordCount: transcript.split(/\s+/).filter(Boolean).length
    };
    writeFileSync(metaPath(id), JSON.stringify(meta, null, 2), "utf8");

    // Clean up audio file (transcript is the artifact we keep)
    try { unlinkSync(wavFile); } catch {}

    return {
      content: [{
        type: "text",
        text: `Transcription complete.\n\nMeeting: ${meetingTitle}\nDate: ${new Date(startTime).toLocaleString()}\nDuration: ${durationStr}\nWords: ${meta.wordCount}\n\n--- TRANSCRIPT ---\n${transcript}`
      }]
    };
  }
);

// ── Tool: list_meetings ───────────────────────────────────────────────────────
server.tool(
  "list_meetings",
  "List all saved meeting transcripts",
  {},
  async () => {
    const files = readdirSync(TRANSCRIPTS_DIR).filter(f => f.endsWith(".json"));

    if (files.length === 0) {
      return { content: [{ type: "text", text: "No meetings saved yet." }] };
    }

    const meetings = files
      .map(f => {
        try { return JSON.parse(readFileSync(join(TRANSCRIPTS_DIR, f), "utf8")); }
        catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const list = meetings.map(m =>
      `[${m.id}] ${m.title}\n  Date: ${new Date(m.date).toLocaleString()}  |  Duration: ${m.duration}  |  Words: ${m.wordCount}`
    ).join("\n\n");

    return { content: [{ type: "text", text: `${meetings.length} meeting(s) saved:\n\n${list}` }] };
  }
);

// ── Tool: get_transcript ──────────────────────────────────────────────────────
server.tool(
  "get_transcript",
  "Read the full transcript of a saved meeting by ID",
  {
    id: z.string().describe("Meeting ID from list_meetings (e.g. 2026-04-15T14-30-00)")
  },
  async ({ id }) => {
    const tPath = transcriptPath(id);
    const mPath = metaPath(id);

    if (!existsSync(tPath)) {
      return { content: [{ type: "text", text: `No transcript found for ID: ${id}` }] };
    }

    const transcript = readFileSync(tPath, "utf8");
    let meta = {};
    try { meta = JSON.parse(readFileSync(mPath, "utf8")); } catch {}

    return {
      content: [{
        type: "text",
        text: `Meeting: ${meta.title || id}\nDate: ${meta.date ? new Date(meta.date).toLocaleString() : "unknown"}\nDuration: ${meta.duration || "unknown"}\n\n--- TRANSCRIPT ---\n${transcript}`
      }]
    };
  }
);

// ── Tool: delete_meeting ──────────────────────────────────────────────────────
server.tool(
  "delete_meeting",
  "Delete a saved meeting transcript and its metadata",
  {
    id: z.string().describe("Meeting ID to delete")
  },
  async ({ id }) => {
    const tPath = transcriptPath(id);
    const mPath = metaPath(id);

    let deleted = [];
    if (existsSync(tPath)) { unlinkSync(tPath); deleted.push("transcript"); }
    if (existsSync(mPath)) { unlinkSync(mPath); deleted.push("metadata"); }

    if (deleted.length === 0) {
      return { content: [{ type: "text", text: `No files found for ID: ${id}` }] };
    }

    return { content: [{ type: "text", text: `Deleted ${deleted.join(" and ")} for meeting: ${id}` }] };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
