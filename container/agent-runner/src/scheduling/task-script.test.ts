import { describe, expect, it } from 'bun:test';

import { selectScriptRuntime } from './task-script.js';

describe('selectScriptRuntime', () => {
  it('keeps shell scripts on bash', () => {
    const runtime = selectScriptRuntime('set -e\nprintf \'{"wakeAgent":false}\\n\'\n');

    expect(runtime.command).toBe('bash');
    expect(runtime.extension).toBe('sh');
  });

  it('runs ES module scripts with node', () => {
    const runtime = selectScriptRuntime(
      "import fs from 'fs';\nconsole.log(JSON.stringify({ wakeAgent: false }));\n",
    );

    expect(runtime.command).toBe('node');
    expect(runtime.extension).toBe('mjs');
  });

  it('runs node shebang scripts with node', () => {
    const runtime = selectScriptRuntime(
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({ wakeAgent: false }));\n",
    );

    expect(runtime.command).toBe('node');
    expect(runtime.extension).toBe('mjs');
  });
});
