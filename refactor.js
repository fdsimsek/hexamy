const fs = require("fs");
try {
  const content = fs.readFileSync("public/index.html", "utf8");
  const lines = content.split("\n");

  const css = lines.slice(7, 1624).join("\n");
  const js = lines.slice(1944, 4443).join("\n");

  fs.writeFileSync("public/style.css", css);
  fs.writeFileSync("public/game.js", js);

  const header = lines.slice(0, 6);
  const middle = lines.slice(1625, 1943);
  const footer = lines.slice(4444);

  const newHtml = [
    ...header,
    '    <link rel="stylesheet" href="style.css">',
    ...middle,
    '    <script src="game.js"></script>',
    ...footer,
  ].join("\n");

  fs.writeFileSync("public/index_new.html", newHtml);
  fs.writeFileSync("PROCESS_STATUS.txt", "COMPLETED SUCCESSFULLY");
} catch (err) {
  fs.writeFileSync("PROCESS_STATUS.txt", "ERROR: " + err.message);
}
