import { build } from "esbuild";

await build({ entryPoints: ["video-processor.worker.js"], bundle: true, format: "esm", platform: "browser", target: ["chrome120", "edge120"], outfile: "video-processor.worker.bundle.js", legalComments: "none" });
console.log("Built browser-only video processor.");
