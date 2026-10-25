export function assertSupportedNode(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const supported = match && (
    Number(match[1]) >= 26 ||
    (Number(match[1]) === 24 && Number(match[2]) >= 15)
  );
  if (!supported) {
    throw new Error(`Jarela requires Node 24.15.0+ on 24.x, or Node 26+; found ${version}. Upgrade Node before starting Jarela.`);
  }
}

export function enforceNodeVersion() {
  try {
    assertSupportedNode();
  } catch (error) {
    console.error(`[jarela] ${error.message}`);
    process.exit(1);
  }
}
