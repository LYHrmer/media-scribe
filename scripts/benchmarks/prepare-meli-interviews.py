#!/usr/bin/env python3
"""Fetch frozen MELI interview excerpts for local, post-inference evaluation.

Dependencies for PCM preparation: numpy==2.3.5 scipy==1.17.0.
No ASR model or inference is run. Media/reference data must stay outside this repo.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import struct
import sys
import urllib.request
import wave

API = 'https://borealisdata.ca/api/access/datafile/'
CORPUS_URL = 'https://doi.org/10.5683/SP3/5WMRUO'
LICENSE = 'CC BY-NC-SA 4.0'
ATTRIBUTION = 'Suyuan Liu and Molly Babel, University of British Columbia, MELI: Mandarin-English Language Interview'
REPO_ROOT = Path(__file__).resolve().parents[2]
SOURCE_RATE, TARGET_RATE = 44100, 16000
# Datafile IDs identify immutable versioned files. These constants contain no gold
# transcript; the human-corrected reference is read from a SHA-pinned TextGrid.
SPECS = (
    dict(id='meli-f01b-zh', recording='F01B_man', language='chinese',
         start=270.6, end=296.2206118033233, audio_id=1116060,
         audio_bytes=260098460, annotation_id=1116056,
         annotation_sha256='d2f1740f1c4cddb4330a291f7edcb244bc45f95a377e03782b9c2332afd18f86',
         source_pcm_sha256='682fe8a27d359478b82625d2bbe6a3858e261b6e737b02a9bdf0b54d898dd963',
         source_wav_sha256='6fed6389e2041c837fd6917744c1a0ca39df83ab8bf750c8cff17fb818b5097f',
         pcm_sha256='b575ec11b47e8f77e2f93c9b70e34f86f76e81098cff87d979ad2c34eff63c56',
         reference_sha256='e6933d5e94a02e812eb2d8d1d39976df8d639aca4d1aece0152f711930e0a2f7',
         upstream_md5='6438151abc58fa21602d2c738b392f90'),
    dict(id='meli-f00a-en', recording='F00A_eng', language='english',
         start=188.68848781556545, end=223.3784126984127, audio_id=1115854,
         audio_bytes=299583696, annotation_id=1115880,
         annotation_sha256='5b50af4c5d725dd77a96721f6389376ed8f75cff00d6ec5c45c84e682cb11f93',
         source_pcm_sha256='8f4fc6f4bafc9de3c015c427001a86a3da9f11b173e0b5eb8d49257bcd685c27',
         source_wav_sha256='699e50f4042d10352fede89e2c3ca207486ed42f86195ad595661dcb906dffc6',
         pcm_sha256='851649f5812e85129633774e3ed12cd142845d587cad389cd839e61cf6ef36f8',
         reference_sha256='80bbaf01da53d7f7b1529ac8ecc2e14069951aeae01af641683e2bcb0b7addf3',
         upstream_md5='96581076d6163b0cce93b96ff4805915'),
    dict(id='meli-m00a-zh', recording='M00A_man', language='chinese',
         start=567.58, end=603.5533299130751, audio_id=1115924,
         audio_bytes=268157128, annotation_id=1115925,
         annotation_sha256='f786414b4f6ae85167d66488b814ca9833d25c003b5cf29fd928e4a76b4af973',
         source_pcm_sha256='14d0254221dc11f376cc4f5a984c13c4d9cb2d7b6d06e3f08b73ee76a83a26f9',
         source_wav_sha256='4163fd417079cb54f382ca5440bd80f27bb4d1c391d509241bbfc5356a890a4b',
         pcm_sha256='973a08588a7784906d4b2c3101bbeff516964d9378ae52f81a2bd22f528bb33d',
         reference_sha256='7a7d8902d778c9fafeabf419186dc79adc746d83eb7bd4ac27d4a488693881d4',
         upstream_md5='565cf2af728cdc14d8ef3ad3d45fd190'),
    dict(id='meli-m00a-en', recording='M00A_eng', language='english',
         start=300.4984748643561, end=339.378908766135, audio_id=1115829,
         audio_bytes=212905288, annotation_id=1115790,
         annotation_sha256='f69e7a42c7c3de425d41fca8bd6514c85e7d51b3e22126db79814c3e34fa9503',
         source_pcm_sha256='8549473e3d1552fccdb9624f61768437a73d03f632d03ef5f54299d258fd8320',
         source_wav_sha256='f5f61c897b48dca8cb824198abf9504c3ee95873bbd98e93d68012c8bf42a2c0',
         pcm_sha256='5e3e56d11815dc8c2205f61f5543a95a1b267f057037f0ac3b38a18ba7d7efcc',
         reference_sha256='6296837a80963295cab83faf31fac2a2867fe449b0ff0408584be7747d47cb67',
         upstream_md5='7d1da2f9b1190f4f4520382243501334'),
)


# Two new-participant Chinese holdouts, selected from annotations before audio
# download and without access to model output or audio RMS. Default SPECS unchanged.
HOLDOUT_SPECS = ({'id': 'meli-holdout-f01a-zh',
  'recording': 'F01A_man',
  'language': 'chinese',
  'start': 249.57205493285298,
  'end': 271.01593909672266,
  'audio_id': 1116059,
  'audio_bytes': 266534980,
  'annotation_id': 1116037,
  'annotation_sha256': '82f21021e17ce835b83bca89940efa298ec1979f075e483fea7fab6d29347e4a',
  'reference_sha256': '0e20fac4340339941a6e16f9907e58ced68d4ad28e976584de254efcdcdf7375',
  'upstream_md5': 'c96a39fe1ea478d72ec00914f733d2ab',
  'source_pcm_sha256': '69c29b2ad1acf133fb8271ad3c59dc98e6a3c45288596ef33e4bb00fb850de26',
  'source_wav_sha256': 'bed2c09f6a3f22f33ee386e1f12b9bbab0b72c140e28097db5bda92504c08385',
  'pcm_sha256': 'eeee334828ca96abd0904e29388accd5f82939d7fdc18a607630cea545ff66a8'},
 {'id': 'meli-holdout-m00b-zh',
  'recording': 'M00B_man',
  'language': 'chinese',
  'start': 1093.3286172688674,
  'end': 1121.3763309094504,
  'audio_id': 1115895,
  'audio_bytes': 309946996,
  'annotation_id': 1115887,
  'annotation_sha256': 'c365b7d82ceeda0e3682288113621735f9ee57a61c1dcd7ad5119bad1b10c539',
  'reference_sha256': 'a200214bc6f2d6418a6aaaf1114411fcf288f08905637b2e61f67832da14f420',
  'upstream_md5': 'cf3e4f9b8481c847aa47f3213635f5ca',
  'source_pcm_sha256': 'c8f507f25ec7b55f2823a78ecce2d1f0b78e0cfcb0ba7a36f6e58853ed41d1e8',
  'source_wav_sha256': '69894f42c5f295fecab0bcfc2dee085a182f5f1af90a41b98539ac9d5567adad',
  'pcm_sha256': '0d36b193d802f0eba21e75cf13f60396da296b92f3f6fe47a1f593cf1320cba3'})
HOLDOUT_SELECTION = {'order': ['F01A_man', 'M00B_man'],
 'rule': 'Before downloading any audio or observing model results: enumerate continuous answer '
         'blocks bounded by interviewer turns in official Interview task; reject whole blocks '
         'containing xxx/@/[REDACTED]; trim boundary non-speech-only annotation intervals; take '
         'first block with duration 20 to 40s. Do not filter by RMS, signal quality, or '
         'recognition output.',
 'frozen_before_audio_download_utc': '2026-10-14T06:47:19.556798+00:00'}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def verify(data, expected, label):
    actual = hashlib.sha256(data).hexdigest()
    require(actual == expected,
            f'{label}: SHA256 mismatch (expected {expected}, got {actual}). '
            'Do not overwrite the frozen hashes to make a changed sample pass.')
    return data


def write_bytes(path, data):
    temporary = path.with_name(path.name + '.partial')
    temporary.write_bytes(data)
    temporary.replace(path)


def fetch(url, *, limit, byte_range=None, total=None):
    headers = {'User-Agent': 'media-scribe-meli-benchmark/1.0'}
    if byte_range is not None:
        first, last = byte_range
        headers['Range'] = f'bytes={first}-{last}'
    request = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(request, timeout=90) as response:
        if byte_range is not None:
            require(response.status == 206, f'{url}: server did not honor HTTP Range; full download refused')
            require(response.headers.get('Content-Range') == f'bytes {first}-{last}/{total}',
                    f'{url}: unexpected Content-Range')
        data = response.read(limit + 1)
    require(len(data) <= limit, f'{url}: response exceeds {limit} bytes')
    if byte_range is not None:
        require(len(data) == last - first + 1, f'{url}: truncated audio range')
    return data


def parse_textgrid(data):
    text = data.decode('utf-16' if data[:2] in (b'\xfe\xff', b'\xff\xfe') else 'utf-8-sig')
    tiers = {}
    for part in re.split(r'\n    item \[\d+\]:', text)[1:]:
        match = re.search(r'name = "([^"]+)"', part)
        require(match is not None, 'TextGrid tier missing name')
        tiers[match[1]] = [dict(start=float(a), end=float(z), text=t.replace('""', '"'))
                          for a, z, t in re.findall(
                              r'intervals \[\d+\]:\s+xmin = ([0-9.]+)\s+xmax = ([0-9.]+)\s+text = "((?:[^"]|"")*)"', part)]
    require('task' in tiers and 'utterance-corrected' in tiers, 'Missing manually corrected TextGrid tiers')
    return tiers


def reference_from_annotation(data, spec):
    tiers = parse_textgrid(data)
    start, end = spec['start'], spec['end']
    selected = [x for x in tiers['utterance-corrected']
                if x['start'] >= start - 1e-6 and x['end'] <= end + 1e-6]
    require(selected and abs(selected[0]['start'] - start) < 1e-6
            and abs(selected[-1]['end'] - end) < 1e-6, 'Frozen utterance boundaries changed')
    require(not any('interviewer' in x['text'] for x in selected), 'Untranscribed interviewer turn in excerpt')
    for left, right in zip(selected, selected[1:]):
        require(abs(left['end'] - right['start']) < 1e-6, 'Excerpt is not a continuous annotated interval')
    tasks = [x for x in tiers['task'] if x['start'] <= start and x['end'] >= end]
    require(len(tasks) == 1 and tasks[0]['text'] == 'Interview', 'Excerpt is not explicitly marked Interview')
    raw = ' '.join(x['text'].strip() for x in selected)
    # A fragment may touch a complete Chinese word (e.g. &n他们). Delete
    # only the Latin fragment, never all following non-whitespace characters.
    reference = re.sub(r'\{[^}]*\}|&[A-Za-z]+', ' ', raw)
    reference = re.sub(r'\s+', ' ', reference).strip()
    require(not re.search(r'xxx|@|&|\[REDACTED\]', reference, re.IGNORECASE),
            'Unexpected unintelligible speech, redaction, code-switch or fragment label')
    if spec['language'] == 'chinese':
        reference = reference.replace(' ', '')
    verify(reference.encode('utf-8'), spec['reference_sha256'], 'Normalized reference')
    return reference, raw, selected, tasks[0]


def wav_bytes(samples, channels, sample_rate):
    output = io.BytesIO()
    with wave.open(output, 'wb') as stream:
        stream.setnchannels(channels)
        stream.setsampwidth(2)
        stream.setframerate(sample_rate)
        stream.writeframes(samples)
    return output.getvalue()


def prepare_case(spec, output, *, offline=False):
    import numpy as np
    import scipy
    from scipy.signal import resample_poly

    annotation_path = output / (spec['recording'] + '.TextGrid')
    if annotation_path.exists():
        annotation = verify(annotation_path.read_bytes(), spec['annotation_sha256'], str(annotation_path))
    else:
        require(not offline, f'Offline cache missing: {annotation_path}')
        annotation = verify(fetch(API + str(spec['annotation_id']), limit=10 * 1024 * 1024),
                            spec['annotation_sha256'], spec['recording'] + '.TextGrid')
        write_bytes(annotation_path, annotation)
    reference, raw, selected, task = reference_from_annotation(annotation, spec)
    start_frame, end_frame = round(spec['start'] * SOURCE_RATE), round(spec['end'] * SOURCE_RATE)
    first, last = 44 + start_frame * 4, 44 + end_frame * 4 - 1
    source_path = output / (spec['id'] + '-source-range.wav')
    if source_path.exists():
        source_wav = verify(source_path.read_bytes(), spec['source_wav_sha256'], str(source_path))
        with wave.open(io.BytesIO(source_wav), 'rb') as stream:
            require((stream.getnchannels(), stream.getsampwidth(), stream.getframerate()) == (2, 2, SOURCE_RATE),
                    'Cached range WAV format changed')
            source_pcm = stream.readframes(stream.getnframes())
    else:
        require(not offline, f'Offline cache missing: {source_path}')
        url = API + str(spec['audio_id'])
        header = fetch(url, limit=44, byte_range=(0, 43), total=spec['audio_bytes'])
        require(header[:4] == b'RIFF' and header[8:16] == b'WAVEfmt ' and header[36:40] == b'data',
                'Source WAV layout changed; fixed byte offsets are no longer valid')
        require(struct.unpack('<HHIIHH', header[20:36]) == (1, 2, SOURCE_RATE, 176400, 4, 16),
                'Source WAV encoding changed')
        source_pcm = fetch(url, limit=last - first + 1, byte_range=(first, last), total=spec['audio_bytes'])
        verify(source_pcm, spec['source_pcm_sha256'], 'Source stereo PCM range')
        source_wav = verify(wav_bytes(source_pcm, 2, SOURCE_RATE), spec['source_wav_sha256'], 'Source range WAV')
        write_bytes(source_path, source_wav)
    verify(source_pcm, spec['source_pcm_sha256'], 'Source stereo PCM range')
    require(len(source_pcm) == last - first + 1, 'Source range frame count changed')
    left = np.frombuffer(source_pcm, dtype='<i2').reshape(-1, 2)[:, 0].astype(np.float32) / 32768
    mono = resample_poly(left, 160, 441).astype('<f4')
    require(np.isfinite(mono).all(), 'Resampler produced non-finite PCM')
    pcm = verify(mono.tobytes(), spec['pcm_sha256'],
                 f"Prepared PCM (numpy {np.__version__}, scipy {scipy.__version__}; frozen with 2.3.5/1.17.0)")
    pcm_path = output / (spec['id'] + '.f32')
    if pcm_path.exists():
        verify(pcm_path.read_bytes(), spec['pcm_sha256'], str(pcm_path))
    else:
        write_bytes(pcm_path, pcm)
    listening_path = output / (spec['id'] + '.wav')
    listening = wav_bytes(np.clip(mono * 32768, -32768, 32767).astype('<i2').tobytes(), 1, TARGET_RATE)
    if listening_path.exists():
        require(listening_path.read_bytes() == listening, f'Listening WAV differs: {listening_path}')
    else:
        write_bytes(listening_path, listening)
    return dict(
        id=spec['id'], language=spec['language'], reference=reference, reference_raw=raw,
        pcm_path=pcm_path.name, pcm_sha256=spec['pcm_sha256'], sample_rate=TARGET_RATE,
        duration_seconds=len(mono) / TARGET_RATE, audio_path=listening_path.name,
        kind='real-interview-answer', recording_id=spec['recording'],
        participant_id=spec['recording'].split('_')[0], corpus='MELI 1.2',
        source=CORPUS_URL, source_audio=API + str(spec['audio_id']),
        source_annotation=API + str(spec['annotation_id']),
        source_annotation_sha256=spec['annotation_sha256'],
        source_range_pcm_sha256=spec['source_pcm_sha256'],
        source_range_wav_sha256=spec['source_wav_sha256'],
        source_audio_upstream_checksum_unverified=dict(type='MD5', value=spec['upstream_md5']),
        source_byte_range=f'bytes={first}-{last}', source_time_start=start_frame / SOURCE_RATE,
        source_time_end=end_frame / SOURCE_RATE, source_task_interval=task, excerpts=selected,
        reference_sha256=spec['reference_sha256'], license=LICENSE, attribution=ATTRIBUTION,
        reference_provenance='Official utterance-corrected tier: initial Whisper-large-v3 draft hand-corrected by bilingual research assistants. Not the output of either tested model.',
        reference_normalization='Remove non-speech {...} and partial-word &fragment annotations; preserve full words, fillers, repetitions and grammar; remove Mandarin whitespace. No normal sentence-punctuation gold.',
        reference_given_to_inference=False,
        channel_policy='Original left participant channel; continuous answer, no annotated interviewer turns. Does not evaluate two-speaker transcription or diarization.',
        recipe=dict(channel='left', source_rate=SOURCE_RATE, target_rate=TARGET_RATE,
                    resampler='scipy.signal.resample_poly(left,160,441)',
                    numpy_version=np.__version__, scipy_version=scipy.__version__,
                    gain_normalization=False, denoising=False, concatenation=False),
        publication_policy='Keep media, full annotations and generated manifest outside the application repository. Any published derivative references retain attribution and CC BY-NC-SA 4.0, not project MIT.')


def argument_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True, help='Local experiment directory outside the repository')
    parser.add_argument('--holdout', action='store_true', help='Prepare only the two new-participant Chinese holdouts; default is the original four cases')
    parser.add_argument('--offline', action='store_true', help='Verify/rebuild from cached TextGrids and source range WAVs; never access the network')
    parser.add_argument('--dry-run', action='store_true', help='Validate arguments and show fixed cases; no writes, downloads or NumPy/SciPy imports')
    return parser


def main(argv=None):
    parser = argument_parser()
    args = parser.parse_args(argv)
    output = args.output_dir.expanduser().resolve()
    if output == REPO_ROOT or REPO_ROOT in output.parents:
        parser.error('--output-dir must be outside the repository; media and reference data must not enter Git')
    specs = HOLDOUT_SPECS if args.holdout else SPECS
    if args.dry_run:
        print(json.dumps(dict(output_dir=str(output), offline=args.offline,
                              cases=[dict(id=s['id'], language=s['language'], start=s['start'], end=s['end']) for s in specs]), indent=2))
        return 0
    output.mkdir(parents=True, exist_ok=True)
    cases = [prepare_case(s, output, offline=args.offline) for s in specs]
    manifest = dict(schema_version=1, benchmark_version=('meli-interviews-holdout-2026-10-14' if args.holdout else 'meli-interviews-2026-10-14'),
                    license=LICENSE, attribution=ATTRIBUTION, dataset_version='1.2',
                    dataset_release_date='2026-10-07',
                    notes=[
                        ('Two Chinese holdouts from participants F01A and M00B, neither used by the original four cases.' if args.holdout else 'Four language-session recordings, three participants; two different participants per language. M00A appears in both languages.'),
                        'Spontaneous interview answers, never the sentence-reading task. English includes non-native accents.',
                        'References were frozen before tested-model output. References are for post-inference scoring only.',
                        'Human-corrected corpus starts from Whisper-large-v3 drafts; this provenance may bias evaluation.',
                        'Only the participant channel has full annotations; not a two-speaker or diarization benchmark.',
                        'Most punctuation is absent from corpus references; do not score punctuation accuracy against them.',
                        'Full source WAV checksum was not locally verified. Source byte ranges, annotation files and prepared PCM are SHA256-pinned.',
                        'Audio and generated reference manifest stay local and are not covered by project MIT.'
                    ], cases=cases)
    if args.holdout:
        manifest['selection'] = HOLDOUT_SELECTION
        manifest['notes'].extend([
            'Selected without ASR results, RMS or signal-quality screening; no threshold tuning on these holdouts.',
            'M00B retains an approximately 9.8-second natural thinking pause inside one continuous answer.'
        ])
    destination = output / ('holdout.local.json' if args.holdout else 'cases.local.json')
    write_bytes(destination, (json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    print(json.dumps(dict(cases=len(cases), seconds=sum(c['duration_seconds'] for c in cases),
                          manifest=str(destination), offline=args.offline), ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, ImportError) as error:
        print(f'Preparation failed: {error}', file=sys.stderr)
        raise SystemExit(1)
