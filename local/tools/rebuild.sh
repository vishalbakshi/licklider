#!/bin/sh
# Download the essay PDF and build app/paper.json + app/figures/ (macOS: uses PDFKit via Swift).
# The essay itself is not in the repo; your annotations.json lines up with what this builds.
set -e
cd "$(dirname "$0")/.."
URL="https://internetat50.com/references/Licklider_Taylor_The-Computer-As-A-Communications-Device.pdf"

mkdir -p source build/ex
[ -f source/paper.pdf ] || curl -fsSL "$URL" -o source/paper.pdf
swift tools/extract.swift source/paper.pdf build/ex
python3 -I tools/build.py build/ex/layout.json build/ex app
echo "Built. Run: python3 server.py"
