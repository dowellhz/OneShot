#!/bin/bash
# Official diffusers components (VAEs, scheduler, tokenizer, processor, configs), H3-Image and the prompt guides,
# from ModelScope (set MS=https://huggingface.co and the repo names below to use Hugging Face instead).
# The single-file transformers, the text encoder and the turbo LoRAs come from Comfy-Org/MiniMax-H3 (see README).
set -eu
MS=${MS:-https://www.modelscope.cn/models}
BASE=${H3_BASE:-$HOME/h3engine/MiniMax-H3}
IMG=${H3_IMAGE_BASE:-$HOME/h3engine/MiniMax-H3-Image}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

get() {   # repo path dest — skip files already there, resume partial ones
  mkdir -p "$(dirname "$3")"
  if [ -s "$3" ]; then return 0; fi
  curl -fL --retry 5 -C - -o "$3.part" "$MS/$1/resolve/master/$2"
  mv -f "$3.part" "$3"
}

for f in model_index.json modular_model_index.json scheduler/scheduler_config.json audio_scheduler/scheduler_config.json \
         vae/config.json vae/diffusion_pytorch_model.safetensors.index.json \
         vae/diffusion_pytorch_model-00001-of-00003.safetensors vae/diffusion_pytorch_model-00002-of-00003.safetensors \
         vae/diffusion_pytorch_model-00003-of-00003.safetensors audio_vae/config.json audio_vae/diffusion_pytorch_model.safetensors \
         transformer/config.json transformer_ref/config.json text_encoder/config.json text_encoder/generation_config.json \
         tokenizer/merges.txt tokenizer/tokenizer.json tokenizer/tokenizer_config.json tokenizer/vocab.json \
         processor/chat_template.json processor/merges.txt processor/preprocessor_config.json processor/tokenizer.json \
         processor/tokenizer_config.json processor/video_preprocessor_config.json processor/vocab.json; do
  get MiniMax/MiniMax-H3 "$f" "$BASE/$f"
done

mkdir -p "$ROOT/guides"
get MiniMax/MiniMax-H3 docs/VIDEO_PROMPT_WRITING_GUIDE_base_en.md "$ROOT/guides/base_en.md"
get MiniMax/MiniMax-H3 docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md "$ROOT/guides/ref_en.md"

if [ "${SKIP_IMAGE:-0}" != "1" ]; then   # H3-Image: ~68 GB
  for f in model_index.json modular_model_index.json scheduler/scheduler_config.json vae_diffusers/config.json \
           vae_diffusers/diffusion_pytorch_model.safetensors transformer_diffusers/config.json \
           transformer_diffusers/diffusion_pytorch_model.safetensors.index.json; do
    get MiniMax/MiniMax-H3-Image "$f" "$IMG/$f"
  done
  for i in $(seq -w 1 12); do
    f=transformer_diffusers/diffusion_pytorch_model-000$i-of-00012.safetensors
    get MiniMax/MiniMax-H3-Image "$f" "$IMG/$f" &
    [ $((10#$i % 4)) -eq 0 ] && wait      # four at a time: ModelScope limits each connection
  done
  wait
fi
echo "done: $BASE ${SKIP_IMAGE:+(image skipped)}"
