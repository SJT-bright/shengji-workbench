#!/usr/bin/env python3
"""Shengji offline Chinese ASR; reads installed models without modifying the phone service."""
import argparse
import contextlib
import json
import os
import pathlib
import socket
import sys
import wave

# Fail closed: no model package can silently fetch weights, telemetry or remote code.
def deny_network(*_args, **_kwargs):
    raise RuntimeError('离线转写禁止网络访问；请检查本机模型文件是否完整')

socket.socket.connect = deny_network
socket.socket.connect_ex = deny_network
socket.create_connection = deny_network
os.environ.update({'HF_HUB_OFFLINE': '1', 'TRANSFORMERS_OFFLINE': '1',
                   'HF_DATASETS_OFFLINE': '1', 'MODELSCOPE_OFFLINE': '1',
                   'TOKENIZERS_PARALLELISM': 'false', 'OMP_NUM_THREADS': '4',
                   'MKL_NUM_THREADS': '4', 'OMP_WAIT_POLICY': 'PASSIVE'})

NAMES = [
    'iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch',
    'iic--speech_fsmn_vad_zh-cn-16k-common-pytorch',
    'iic--punc_ct-transformer_cn-en-common-vocab471067-large',
]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--models', required=True)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--audio')
    parser.add_argument('--output')
    args = parser.parse_args()
    paths = [pathlib.Path(args.models) / 'modelscope' / 'models' / name / 'snapshots' / 'master' for name in NAMES]
    for model in paths:
        for filename in ('config.yaml', 'model.pt'):
            if not (model / filename).is_file():
                raise RuntimeError('缺少本地模型文件：' + str(model / filename))
    # Import only: availability doesn't run inference or load gigabytes of weights.
    with contextlib.redirect_stdout(sys.stderr):
        import numpy as np
        import torch
        from funasr import AutoModel
    if args.check:
        print(json.dumps({'available': True, 'engine': 'funasr-paraformer-zh'}))
        return
    if not args.audio or not args.output:
        raise RuntimeError('缺少音频或输出路径')
    with wave.open(args.audio, 'rb') as audio:
        if audio.getnchannels() != 1 or audio.getframerate() != 16000 or audio.getsampwidth() != 2:
            raise RuntimeError('转写需要单声道 16 kHz PCM 音频')
        duration = audio.getnframes() / audio.getframerate()
        if duration <= 0:
            raise RuntimeError('音频没有可读取的声音')
        if duration > 7200:
            raise RuntimeError('音频超过两小时，请分段导入')
        torch.set_num_threads(4)
        torch.set_num_interop_threads(1)
        with contextlib.redirect_stdout(sys.stderr):
            model = AutoModel(model=str(paths[0]), vad_model=str(paths[1]), punc_model=str(paths[2]),
                              device='cpu', ncpu=4, disable_update=True, hub='ms',
                              vad_kwargs={'max_single_segment_time': 30000})
            texts = []
            # Bound memory and process every decoded sample, without truncating the last part.
            while True:
                pcm = audio.readframes(16000 * 300)
                if not pcm:
                    break
                samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768.0
                generated = model.generate(input=samples, fs=16000, batch_size_s=60,
                                           merge_vad=True, merge_length_s=15, disable_pbar=True)
                for item in generated or []:
                    if isinstance(item, dict):
                        text = item.get('text', '')
                        if isinstance(text, str) and text.strip():
                            texts.append(text.strip())
    text = '\n'.join(texts).strip()
    if not text:
        raise RuntimeError('未识别到可转写的语音，请检查录音是否清晰或只有静音')
    pathlib.Path(args.output).write_text(json.dumps({'text': text, 'duration': duration,
        'engine': 'funasr-paraformer-zh', 'language': 'zh'}, ensure_ascii=False), encoding='utf-8')

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print('SHENGJI_ASR_ERROR: ' + str(exc), file=sys.stderr)
        sys.exit(1)
