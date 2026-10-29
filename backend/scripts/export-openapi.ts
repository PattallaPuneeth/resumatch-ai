import { buildServer } from '../src/server.js';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const app = buildServer();
  await app.ready();
  const swaggerSpec = (app as any).swagger();
  const outputPath = path.resolve(process.cwd(), 'openapi.json');
  fs.writeFileSync(outputPath, JSON.stringify(swaggerSpec, null, 2), 'utf-8');
  console.log(`Exported OpenAPI schema to ${outputPath}`);
  await app.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

