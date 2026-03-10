const fs = require("fs");
const content = fs.readFileSync("public/index.html", "utf8");
const lines = content.split("\n");

const header = lines.slice(0, 6);
const middle = lines.slice(1625, 1943);
const footer = lines.slice(4444);

const newContent = [
  ...header,
  '    <link rel="stylesheet" href="style.css">',
  ...middle,
  '    <script src="game.js"></script>',
  ...footer,
].join("\n");

fs.writeFileSync("public/index.html", newContent);
console.log("Successfully updated public/index.html");
