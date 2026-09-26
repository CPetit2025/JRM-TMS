const fs = require('fs');
const file = 'C:/Users/LENOVO T580/Claude/JRM_SCM/jrm-tms/src/app/(dashboard)/mantenimiento/documentos/page.tsx';
let data = fs.readFileSync(file, 'utf8');
const lines = data.split(/\r?\n/);
let changed = false;
for (let i=0; i<lines.length; i++) {
  if (lines[i].indexOf('order-b last:border-0') !== -1) {
    lines[i] = '                      className="border-b last:border-0 hover:bg-muted/30 transition-colors"';
    changed = true;
  }
}
if (changed) {
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  console.log("Replaced successfully!");
} else {
  console.log("String not found in file.");
}
