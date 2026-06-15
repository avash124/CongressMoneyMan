const loadEnvFile = (
  process as unknown as { loadEnvFile?: (path?: string) => void }
).loadEnvFile

try {
  loadEnvFile?.(".env.local")
} catch {
}
