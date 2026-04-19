#!/usr/bin/env python3

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path

import pypdfium2 as pdfium


def render_page_image(page, output_path: Path, scale: float) -> None:
    bitmap = page.render(scale=scale)
    image = bitmap.to_pil()
    image.save(output_path)


def run_tesseract(image_path: Path, languages: str) -> str:
    result = subprocess.run(
        [
            "tesseract",
            str(image_path),
            "stdout",
            "-l",
            languages,
            "--psm",
            "3",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def normalize_page_text(text: str) -> str:
    lines = [line.rstrip() for line in text.replace("\r\n", "\n").split("\n")]
    compact = []
    blank_pending = False

    for raw in lines:
      line = raw.strip()
      if not line:
          blank_pending = True
          continue

      if blank_pending and compact:
          compact.append("")
      compact.append(line)
      blank_pending = False

    return "\n".join(compact).strip()


def extract_pdf_markdown(input_path: Path, scale: float, languages: str) -> str:
    document = pdfium.PdfDocument(str(input_path))
    pages = []

    with tempfile.TemporaryDirectory(prefix="smart-import-ocr-") as temp_dir:
        temp_root = Path(temp_dir)
        for index in range(len(document)):
            page = document[index]
            image_path = temp_root / f"page-{index + 1}.png"
            render_page_image(page, image_path, scale)
            page_text = normalize_page_text(run_tesseract(image_path, languages))
            if page_text:
                pages.append(f"## 第 {index + 1} 页\n\n{page_text}")

    return "\n\n".join(pages).strip() + "\n" if pages else ""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--scale", type=float, default=2.4)
    parser.add_argument("--languages", default="chi_sim+eng")
    args = parser.parse_args()

    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    markdown = extract_pdf_markdown(input_path, args.scale, args.languages)
    output_path.write_text(markdown, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
