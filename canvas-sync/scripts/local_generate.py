#!/usr/bin/env python3
"""Headless one-shot generation with the local MLX model.

Reads the prompt from stdin, prints ONLY the model's response to stdout
(no banners, no stats, thinking blocks stripped). Used by _util.js
localInvoke() as the local backend for canvas-sync AI jobs.

Run with the mlx venv python, e.g.:
  echo "hi" | ~/mlx-env/bin/python local_generate.py --max-tokens 100
"""
import argparse
import re
import sys

from mlx_lm import load, generate

DEFAULT_MODEL = "mlx-community/Qwen3.6-35B-A3B-OptiQ-4bit"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--max-tokens", type=int, default=8192)
    args = ap.parse_args()

    prompt = sys.stdin.read()
    if not prompt.strip():
        print("empty prompt on stdin", file=sys.stderr)
        sys.exit(2)

    print("loading model...", file=sys.stderr)
    model, tokenizer = load(args.model)

    messages = [{"role": "user", "content": prompt}]
    try:
        # Qwen chat templates accept enable_thinking; JSON-extraction jobs
        # don't need a visible reasoning trace.
        templated = tokenizer.apply_chat_template(
            messages, add_generation_prompt=True, enable_thinking=False
        )
    except TypeError:
        templated = tokenizer.apply_chat_template(messages, add_generation_prompt=True)

    print("generating...", file=sys.stderr)
    text = generate(model, tokenizer, prompt=templated, max_tokens=args.max_tokens, verbose=False)

    # Belt-and-braces: strip any thinking block the template still emitted.
    text = re.sub(r"<think>[\s\S]*?</think>", "", text).strip()
    sys.stdout.write(text)


if __name__ == "__main__":
    main()
