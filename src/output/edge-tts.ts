import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const execFileAsync = promisify(execFile);

export class EdgeTTSProcessor {
  private voice: string;
  private tempDir: string;

  constructor(config: { voice: string; tempDir: string }) {
    this.voice = config.voice;
    this.tempDir = config.tempDir;
  }

  async synthesize(text: string): Promise<string> {
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }

    const filename = `tts-${uuidv4()}.ogg`;
    const outputPath = path.resolve(this.tempDir, filename);

    const cleanText = text
      .replace(/[*_~`#>\-\[\]()!|{}]/g, "")
      .replace(/\n+/g, " ")
      .trim();

    try {
      await execFileAsync("edge-tts", [
        "--voice", this.voice,
        "--text", cleanText,
        "--write-media", outputPath,
      ], { timeout: 60000 });

      return outputPath;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Edge-TTS synthesis failed: ${msg}`);
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync("edge-tts", ["--version"], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
}