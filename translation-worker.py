import json
import os
import sys
from pathlib import Path

import ctranslate2
import sentencepiece as spm


model_root = Path(os.environ["TRANSLATION_MODEL_DIR"])
tokenizer = spm.SentencePieceProcessor(model_file=str(model_root / "sentencepiece.model"))
translator = ctranslate2.Translator(str(model_root / "model"), device="cpu")


def translate_to_chinese(text):
    source_tokens = tokenizer.encode(text, out_type=str)
    result = translator.translate_batch(
        [source_tokens],
        beam_size=4,
        num_hypotheses=1,
        length_penalty=0.2,
        replace_unknowns=True,
    )[0]
    target_tokens = result.hypotheses[0]
    return tokenizer.decode_pieces(target_tokens).replace("▁", " ").replace("_", " ").lstrip()


def respond(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


for raw_line in sys.stdin:
    try:
        payload = json.loads(raw_line)
        request_id = str(payload.get("id", ""))
        text = str(payload.get("text", "")).strip()
        if not request_id or not text:
            raise ValueError("Missing translation input")
        translated = translate_to_chinese(text).strip()
        if not translated:
            raise RuntimeError("The translation model returned no text")
        respond({"id": request_id, "translatedText": translated})
    except Exception as error:
        respond({"id": str(locals().get("request_id", "")), "error": str(error)})
