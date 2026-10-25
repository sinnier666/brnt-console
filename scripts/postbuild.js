// Post-build step: copy static assets into the standalone server output.
//
// `output: "standalone"` is only used for local/container node-server hosting.
// Netlify and Vercel build with their own native Next.js runtimes and produce
// no .next/standalone — so this step is skipped there (it would fail the build
// otherwise, which is exactly what happened on the first Vercel deploy).
const fs = require("fs");

if (fs.existsSync(".next/standalone")) {
  fs.cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
  fs.cpSync("public", ".next/standalone/public", { recursive: true });
  console.log("[postbuild] standalone assets copied");
} else {
  console.log("[postbuild] no standalone output (Netlify/Vercel native build) - skipped");
}
