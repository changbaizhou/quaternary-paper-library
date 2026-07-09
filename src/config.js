import path from "node:path";

const rootDir = process.cwd();

export const defaultConfig = {
  port: Number(process.env.PORT || 8000),
  dbPath: process.env.QPL_DB_PATH || path.join(rootDir, "library", "library.sqlite"),
  filesDir: process.env.QPL_FILES_DIR || path.join(rootDir, "library", "files"),
  staticDir: process.env.QPL_STATIC_DIR || path.join(rootDir, "public")
};

