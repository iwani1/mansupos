# Signing and updating Mansu POS for Windows

The Windows till (`desktop/online`) is ready for code signing and signed automatic updates. Two things are still needed from the owner: a **code-signing certificate**, and the **first signed release installed by hand** on each till PC.

## 1. Get a certificate

The certificate is issued to the business (or a person) after an identity check. Any of these works with the CI build:

| Route | Rough cost | Notes |
|---|---|---|
| OV code-signing certificate (Sectigo, SSL.com, DigiCert…) | about US$200–400 / year | Standard choice for a registered business. New CA rules mean the key lives on a hardware token or in the CA's cloud signing service, not a plain `.pfx` file. SmartScreen warnings fade as installs build reputation. |
| EV code-signing certificate | about US$300–600 / year | Stricter company checks. Microsoft has reduced EV's head start with SmartScreen, so OV is usually enough. |
| Azure Trusted Signing | about US$10 / month | Microsoft's managed signing. Check identity-validation eligibility for a Ghana business first; using it needs a change to the build step (electron-builder `azureSignOptions`). |

Keep the subject (business name, town, country) the same when the certificate is renewed: tills accept an update only from the **same publisher subject** as the one they are running.

## 2. Let CI sign

CI already signs when two repository secrets exist (GitHub → Settings → Secrets and variables → Actions):

- `WIN_CSC_LINK`: the certificate as a base64 `.pfx` or an HTTPS link to it
- `WIN_CSC_KEY_PASSWORD`: its password

A hardware-token or cloud-HSM certificate cannot be exported as a `.pfx`. Then sign on a trusted Windows PC with the vendor's tool, or switch the CI step to the vendor's signing service. Never commit a certificate or password.

With the secrets set, a push whose commit message contains `[online-qa]` builds the till in the `online-till-package` job. The job fails unless Windows reports a **Valid** signature, and prints the signer and the installer's SHA-256 (also in `SHA256.txt` in the artifact).

## 3. Publish a release

1. Raise the version in `desktop/online/package.json` (for example `2.1.0`) and push with `[online-qa]`.
2. Download the artifact. Check `SHA256.txt` against the installer (`Get-FileHash … -Algorithm SHA256`) and its signature (`Get-AuthenticodeSignature …`, Status `Valid`, your business as signer).
3. Upload the installer to a host listed in `desktop/online/till.json` → `downloadHosts`. The simplest is `https://mansupos.com/download/…`. A GitHub Release link only works if every redirect ends on a listed host.
4. Publish the release notice on the platform server:

   ```bash
   npm run platform -- till-release --version 2.1.0 --url https://mansupos.com/download/Mansu-POS-ONLINE-2.1.0-Windows-Setup.exe --sha256 <64 hex> --notes "What changed"
   ```

## 4. What a till does with it

- **Unsigned till (every till installed so far):** shows *Mansu POS 2.1.0 is available* with a **Download** button. Nothing installs by itself.
- **Signed till:** every 12 hours (and from *Help → Check for updates*) it downloads the new installer. It keeps the installer only if all of these hold:
  - its SHA-256 equals the published one;
  - Windows reports a Valid signature;
  - the signer's subject equals the running till's.

  Staff see *ready to install*. It installs silently **when the till is closed** and reopens; *Help → Install update now…* does it sooner. It never installs while the till is open, so a sale is not interrupted. A download that fails any check is deleted, and staff can still download it themselves.

**First signed release:** an unsigned till cannot verify a publisher, so install the first signed version **by hand** on each PC (download, check the signer, run it over the top). From then on, updates are automatic.

**Rollback:** tills only move to a *higher* version number. To undo a bad release, rebuild the previous code with a higher version (for example `2.1.1`) and publish that.

## 5. Acceptance on the shop PC (add to the checklist in WINDOWS-ONLINE-TILL.md)

- [ ] Installer properties → Digital Signatures shows the business; SmartScreen shows the business as publisher.
- [ ] Publish a test release one version higher. Within a check (or *Help → Check for updates*) the till says *ready to install*. Close the till: it installs and reopens on the new version; shop, printer and drawer settings are kept.
- [ ] Publish a release with a wrong SHA-256: the till refuses it and offers the manual download instead.
