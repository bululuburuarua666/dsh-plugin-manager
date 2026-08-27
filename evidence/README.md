# Evidence

Machine-readable quadrant records emitted by `pnpm run test:stock`
(`--deployment=<npm|source>` × `--install=<tgz|git>`). One JSON per
quadrant, written only from that quadrant's own checks — never copied.
CI uploads these plus boot logs as workflow artifacts; local runs
overwrite them with the latest result.
