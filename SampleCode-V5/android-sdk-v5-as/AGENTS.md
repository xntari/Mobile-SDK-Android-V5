# Repository Guidelines

## Project Structure & Module Organization
- Root contains Android Gradle wrapper and scripts; modules are mapped in `settings.gradle`:
  - `:sample` → `../android-sdk-v5-sample`
  - `:uxsdk` → `../android-sdk-v5-uxsdk`
- Key directories:
  - `dji-controller-interface/` (TypeScript/Electron UI)
  - `docs/` (specs, snapshots), `web_assets/`, `apk_analysis/`
  - Shell tools: `build.sh`, `deploy.sh`, `build_and_deploy.sh`, `test_system.sh`, `verify_system.sh`

## Build, Test, and Development Commands
- Android builds (preferred):
  - `./build.sh debug|release|both|clean` — wraps Gradle; creates APK under `sample/build/outputs/apk/`
  - Direct Gradle: `./gradlew :sample:assembleDebug`
- Deploy to device/controller:
  - `./deploy.sh [debug|release] [DEVICE_ID] [--logs|--no-launch]`
  - Utilities: `./deploy.sh devices | logs | joystick | vstick | status`
- End‑to‑end smoke test: `./test_system.sh` (automates bridge + UI checks)
- Desktop UI (browser dev):
  - `cd dji-controller-interface && npm install && npm run dev:browser`

## Coding Style & Naming Conventions
- Android (Kotlin/Java): 4‑space indent; Android/Kotlin style; classes `UpperCamelCase`, methods/fields `lowerCamelCase`.
  - Resources: `activity_*`, `fragment_*`, `ic_*`, `color_*`.
  - Log tags: concise UPPER_SNAKE (e.g., `SDK_REGISTRATION`).
- TypeScript/React (dji-controller-interface): Prettier defaults, 2‑space indent; components `PascalCase`, hooks `useX`.
  - Run formatting when touching files: `npx prettier -w dji-controller-interface/**/*.{ts,tsx,css,md}`.
- Shell: `bash -euo pipefail`; keep scripts idempotent and chatty.

## Testing Guidelines
- This repo has no mandatory unit‑test target; favor targeted tests where logic is added.
- Android (if tests exist in `:sample`):
  - Unit tests: `./gradlew :sample:testDebugUnitTest`
  - Instrumentation: `./gradlew :sample:connectedDebugAndroidTest`
- System checks: `./verify_system.sh` and `./deploy.sh --logs debug` for runtime validation.

## Commit & Pull Request Guidelines
- Commits: short, imperative, scope‑first when helpful; emoji allowed; keep subject ≤72 chars (e.g., `hsi: add obstacle scaling`).
- PRs: include description, scope, linked issues, repro/validation steps, device/SDK used, and screenshots/logs for UI/runtime changes. Update docs (`README.md`, `docs/`). Ensure `./build.sh` and `./deploy.sh` succeed.

## Security & Configuration Tips
- Do not commit secrets/keystores, APKs, `build/`, logs, or `local.properties`.
- Require JDK 17 and `ANDROID_SDK_ROOT` set. Modules referenced in `settings.gradle` must exist as sibling directories.
