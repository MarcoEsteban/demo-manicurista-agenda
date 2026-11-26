import { execFileSync } from "node:child_process";

// Deployment público del QR. Se actualiza EN EL LUGAR para conservar la URL.
// En la primera publicación dejalo vacío: el script crea el deployment y te
// muestra el ID, que después pegás acá (o pasás por DEPLOYMENT_ID).
const DEPLOYMENT_ID = process.env.DEPLOYMENT_ID
  || "AKfycbyMd6bS9Sq0XgY3RlCYslTMjOWcYodOqYWVUzgBdlmqyNRb_yZxQepgOyy-buo2LR1X";

const descripcion = process.argv.slice(2).join(" ").trim()
  || `deploy ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;

execFileSync("npx", ["clasp", "push", "--force"], { stdio: "inherit" });

const args = ["clasp", "deploy", "-d", descripcion];
if (DEPLOYMENT_ID) args.push("-i", DEPLOYMENT_ID);
execFileSync("npx", args, { stdio: "inherit" });

if (DEPLOYMENT_ID) {
  console.log(`\nDeployment actualizado sin cambiar la URL (${descripcion}).`);
} else {
  console.log("\nPrimer deployment creado. Copiá el ID a `scripts/deploy.mjs` para conservar la URL en los próximos deploys.");
}
