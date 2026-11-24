"""Audio generation capabilities and recipe fields."""

AUDIO_GENERATION_MODES = {"tts":"配音", "music":"音乐生成", "sfx":"音效生成", "seed_audio":"参考音频生成"}


AUDIO_SETTINGS = ("voice","speed","lyrics","provider","duration_seconds","prompt_influence","loop","subtitles",
                  "audio_format","sample_rate","pitch_semitones","gain","references")
