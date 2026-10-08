import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";

const execFileAsync = promisify(execFile);

export class WhisperProcessor {
  private modelPath: string;
  private binaryPath: string;

  constructor(config: { modelPath: string; binaryPath: string }) {
    this.modelPath = config.modelPath;
    this.binaryPath = config.binaryPath;
  }

  async transcribe(audioFilePath: string): Promise<string> {
    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`);
    }

    try {
      const { stdout } = await execFileAsync(
        this.binaryPath,
        [
          "--model", this.modelPath,
          "--file", audioFilePath,
          "--output-txt",
          "--output-file", audioFilePath.replace(/\.\w+$/, ""),
        ],
        { timeout: 60000 }
      );

      const txtPath = audioFilePath.replace(/\.\w+$/, ".txt");
      if (fs.existsSync(txtPath)) {
        const text = fs.readFileSync(txtPath, "utf-8").trim();
        try { fs.unlinkSync(txtPath); } catch {}
        return text;
      }

      return stdout.trim();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("ETIMEDOUT") || msg.includes("killed")) {
        throw new Error(`Whisper timeout: ${msg}`);
      }
      throw new Error(`Whisper transcription failed: ${msg}`);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.binaryPath, ["--version"], { timeout: 5000 });
      return fs.existsSync(this.modelPath);
    } catch {
      return false;
    }
  }
}