# Installing DSH Plugin Manager

> Community project; not affiliated with or endorsed by DeepSeek.
> Compatible with DeepSeek Harness `0.1.1-rc.2` only (see `compatibility.json`).

## From a GitHub Release (ZIP)

1. Download the Release ZIP and unpack it.
2. Verify the tarball against `SHA256SUMS.txt`:

   ```powershell
   Get-FileHash .\dsh-plugin-manager-<version>.tgz -Algorithm SHA256
   ```

3. Install into your profile (source checkout users prefix `pnpm`):

   ```powershell
   dsh plugin --profile web add .\dsh-plugin-manager-<version>.tgz
   dsh --profile web --dump-config   # shows the dsh-plugin-manager row
   dsh web                            # restart; Settings → Plugins → Plugin manager
   ```

4. After installing, the download folder can be deleted — the profile does
   not link back to it.

## From Git (pinned tag)

```powershell
dsh plugin --profile web add "git+https://github.com/bululuburuarua666/dsh-plugin-manager.git#v<version>"
```

The package ships prebuilt `lib/` and declares no install scripts, so Git
installs need no build approval.

## Uninstall

```powershell
dsh plugin --profile web remove @bululuburuarua666/dsh-plugin-manager
```

Restart DSH afterwards; the tab and its bundle row disappear. Recovery data
(backups, pending-removal records) is kept under `$DSH_HOME` and is never
deleted by the uninstaller.
