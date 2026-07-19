import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const child = spawn("npx", ["vitest", "run", ...args], { stdio: ["inherit", "pipe", "inherit"] });

let stdout = "";
child.stdout.on("data", (data) => {
  stdout += data.toString();
  process.stdout.write(data);
});

child.on("close", (code) => {
  if (code !== 0) {
    process.exit(code);
  }
  const match = /Tests\s+(\d+)\s+passed|Tests\s+(\d+)\s+failed/i.exec(stdout);
  const totalRun = match ? parseInt(match[1] || match[2] || "0", 10) : 0;
  
  if (totalRun === 0 && !stdout.includes("passed") && !stdout.includes("failed")) {
    console.error("\nError: No tests were actually run (only skipped or empty)!");
    process.exit(1);
  }
  process.exit(0);
});
