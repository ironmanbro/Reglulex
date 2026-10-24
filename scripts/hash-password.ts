// Prints an ADMIN_PASSWORD_HASH value. Usage: pnpm admin:hash-password  (reads the password from stdin)
import { createInterface } from "node:readline";
import { hashPassword } from "@/lib/password";

const rl = createInterface({ input: process.stdin, output: process.stderr });
rl.question("Admin password (min 12 chars): ", async (pw) => {
  rl.close();
  try {
    console.log(await hashPassword(pw.trim()));
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
});
