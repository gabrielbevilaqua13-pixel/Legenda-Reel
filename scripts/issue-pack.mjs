import { issuePack } from "../src/lib/credits-store.server.ts";
console.log(await issuePack(process.argv[2] ?? ""));
