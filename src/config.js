import path from "node:path";

const rootDir = process.cwd();
const defaultDbPath = process.env.QPL_DB_PATH || path.join(rootDir, "library", "library.sqlite");

export const defaultConfig = {
  port: Number(process.env.PORT || 8000),
  dbPath: defaultDbPath,
  filesDir: process.env.QPL_FILES_DIR || path.join(rootDir, "library", "files"),
  backupsDir: path.join(path.dirname(defaultDbPath), "backups"),
  staticDir: process.env.QPL_STATIC_DIR || path.join(rootDir, "public")
};

