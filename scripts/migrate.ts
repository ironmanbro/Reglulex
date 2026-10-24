import { closeDb, db } from "@/lib/db";
import { migrate } from "@/lib/migrate";
import { log } from "@/lib/log";

const ran = await migrate(db());
log.info("migrations complete", { applied: ran });
await closeDb();
