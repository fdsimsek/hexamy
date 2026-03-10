const fs = require("fs");
const path = require("path");
const input = "public/index.html";
const outJs = "public/game.js";
const outCss = "public/style.css";

try {
  const content = fs.readFileSync(input, "utf8");
  const lines = content.split("\n");
  console.log("Total lines in index.html: " + lines.length);

  // JS: 1945 to 4443 (1-based) -> indices 1944 to 4443
  const jsLines = lines.slice(1944, 4443);
  fs.writeFileSync(outJs, jsLines.join("\n"));
  console.log("Wrote game.js: " + jsLines.length + " lines");

  // CSS: 8 to 1624 (1-based) -> indices 7 to 1624
  const cssLines = lines.slice(7, 1624);
  fs.writeFileSync(outCss, cssLines.join("\n"));
  console.log("Wrote style.css: " + cssLines.length + " lines");
} catch (e) {
  console.error("Error: " + e.message);
}
