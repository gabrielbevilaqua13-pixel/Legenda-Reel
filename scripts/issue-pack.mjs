import { issuePack } from "../src/lib/credits-store.server.mjs";
console.log(issuePack(process.argv[2] ?? ""));
