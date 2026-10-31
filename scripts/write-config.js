const fs = require("fs");
const path = require("path");

const url = (process.env.SUPABASE_URL || "").trim();
const anon = (process.env.SUPABASE_ANON_KEY || "").trim();
const email = (process.env.SUPABASE_EMAIL || "claseclara.app.user@gmail.com").trim();
const target = path.join(__dirname, "..", "static", "cloud-config.js");

if (!url || !anon) {
  if (process.env.CI) {
    console.error("Faltan SUPABASE_URL y SUPABASE_ANON_KEY en el sitio de Netlify.");
    process.exit(1);
  }
  console.log("Sin variables de Supabase: se deja la configuración local.");
  process.exit(0);
}

const js = `window.CLASECLARA_CLOUD = ${JSON.stringify({ url, anon, email })};\n`;
fs.writeFileSync(target, js);
console.log("Configuración pública escrita. La contraseña no va en la página.");
