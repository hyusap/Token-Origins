import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { VOICE_MODEL, voiceCapabilities } from "../server/transcribe";

async function command(args: string[], cwd?: string) {
  await new Promise<void>((done, fail) => {
    const child = spawn(args[0], args.slice(1), { cwd, stdio: "inherit" });
    const timer = setTimeout(() => { child.kill("SIGKILL"); fail(new Error("Voice setup command timed out")); }, 10 * 60_000);
    child.on("error", error => { clearTimeout(timer); fail(error); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? done() : fail(new Error(`Voice setup command exited ${code}`)); });
  });
}
export async function setupVoice() {
  const dir = resolve(process.env.ORIGINS_VOICE_DATA_DIR || ".data/voice"), source = join(dir, "whisper.cpp"), model = join(dir, "ggml-base.en.bin");
  mkdirSync(dir, { recursive: true, mode: 0o700 }); chmodSync(dir, 0o700);
  const lock = join(dir, "setup.lock");
  const fd = openSync(lock, "wx", 0o600); closeSync(fd);
  try {
    if (!Bun.which("ffmpeg")) throw new Error("Install ffmpeg before setting up voice transcription.");
    if (!Bun.which("cmake") || !Bun.which("git")) throw new Error("Voice setup requires git, cmake, and a C++ compiler.");
    if (!existsSync(source)) await command(["git", "clone", "--depth", "1", "--branch", VOICE_MODEL.version, VOICE_MODEL.repository, source]);
    const actualCommit = (await Bun.$`git -C ${source} rev-parse HEAD`.text()).trim();
    if (actualCommit !== VOICE_MODEL.commit) throw new Error("Unexpected whisper.cpp source commit; installation was left intact for inspection.");
    await command(["cmake", "-S", source, "-B", join(source, "build"), "-DCMAKE_BUILD_TYPE=Release", "-DWHISPER_BUILD_TESTS=OFF", "-DGGML_METAL=OFF", "-DBUILD_SHARED_LIBS=OFF"]);
    await command(["cmake", "--build", join(source, "build"), "--config", "Release", "--target", "whisper-cli", "--parallel", "2"]);
    let valid = existsSync(model) && createHash("sha256").update(readFileSync(model)).digest("hex") === VOICE_MODEL.sha256;
    if (!valid) {
      const partial = `${model}.partial`;
      try {
        writeFileSync(partial, "", { mode: 0o600 }); chmodSync(partial, 0o600);
        await command(["curl", "--fail", "--location", "--proto", "=https", "--tlsv1.2", "--max-time", "300", "--output", partial, VOICE_MODEL.modelUrl]);
        const bytes = readFileSync(partial);
        valid = createHash("sha256").update(bytes).digest("hex") === VOICE_MODEL.sha256 && createHash("sha1").update(bytes).digest("hex") === VOICE_MODEL.sha1;
        if (!valid) throw new Error("Downloaded voice model failed official SHA1 and pinned SHA256 verification.");
        chmodSync(partial, 0o600); renameSync(partial, model);
      } finally { rmSync(partial, { force: true }); }
    }
    chmodSync(model, 0o600); chmodSync(join(source, "build/bin/whisper-cli"), 0o700);
    writeFileSync(join(dir, "installation.json"), JSON.stringify({ ...VOICE_MODEL, installedAt: new Date().toISOString(), modelVerified: true, cpuThreads: 2, networkAtInference: false }, null, 2), { mode: 0o600 });
    if (!voiceCapabilities().available) throw new Error("Installation completed but local voice capabilities are unavailable.");
    console.log("Local voice ready: whisper.cpp v1.8.7 / verified base.en / CPU 2 threads. No audio leaves this machine.");
  } finally { rmSync(lock, { force: true }); }
}
if (import.meta.main) await setupVoice();
