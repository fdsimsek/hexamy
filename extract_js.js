const fs = require("fs");
const path = require("path");
const input = "public/index.html";
const outJs = "public/game.js";

try {
  const content = fs.readFileSync(input, "utf8");
  const lines = content.split("\n");
  console.log("Total lines: " + lines.length);

  // JS: 1945 to 4443
  const jsLines = lines.slice(1944, 4443);
  fs.writeFileSync(outJs, jsLines.join("\n"));
  console.log(
    "Successfully wrote public/game.js: " + jsLines.length + " lines",
  );
} catch (e) {
  console.error(e);
}
