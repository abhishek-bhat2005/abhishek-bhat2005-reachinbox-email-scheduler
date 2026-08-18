import { config as loadDotenv } from "dotenv";
import { fileURLToPath } from "node:url";

const workspaceEnvironmentPath = fileURLToPath(new URL("../../../../.env", import.meta.url));

loadDotenv({ path: workspaceEnvironmentPath, quiet: true });
