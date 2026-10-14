#!/usr/bin/env python3
"""Fetch frozen MELI interview excerpts for local, post-inference evaluation.

Dependencies for PCM preparation: numpy==2.3.5 scipy==1.17.0.
No ASR model or inference is run. Media/reference data must stay outside this repo.
"""
from __future__ import annotations

import argparse
import csv
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


# Five new participants, frozen before inference; original presets remain unchanged.
# Language background is documented, but acoustic accent severity is not graded.
ACCENT_SPECS = ({'id': 'meli-accent-f02a-en',
  'recording': 'F02A_eng',
  'language': 'english',
  'start': 459.84,
  'end': 495.34741742749355,
  'audio_id': 1115810,
  'audio_bytes': 200631384,
  'annotation_id': 1115835,
  'annotation_sha256': 'd697c3a8cb83d42093580a2060af932324dee30124baf9022fd3af56a81f0d3d',
  'reference_sha256': '180606fd56e06f8dd80ff4590a08dab0839e45555a846846007f3ba6082d6adb',
  'upstream_md5': '3046e8737f4d28636389756a6ab5385c',
  'source_pcm_sha256': '7a00bddafd729f871bd247520c3f7c94b5dfa7c6e1141b3e3266e49850c87af5',
  'source_wav_sha256': '6233e1789012fb32aeb5f4438944b673b2443278f7e5eb910553292a2e397473',
  'pcm_sha256': 'a24afaa5804245262f8422800c62c4a68cd3912be4301c4e4a74e9ea66a8df4e'},
 {'id': 'meli-accent-m01a-en',
  'recording': 'M01A_eng',
  'language': 'english',
  'start': 186.84650642208686,
  'end': 208.79033216318442,
  'audio_id': 1115877,
  'audio_bytes': 211110196,
  'annotation_id': 1115795,
  'annotation_sha256': '499d76bade800be7c8f8c417d50781d4b72622605b57540ffca6bc4d812f52af',
  'reference_sha256': '18070c0942bf298f2d6acdf3e5b3499c4e172b23b2b8ba7cb9bb0372b16dbff0',
  'upstream_md5': 'bfdff90bc60793468d041f2923bb09fb',
  'source_pcm_sha256': 'ca48a292eb8c6a64f74266bbf46903c84a5b367e5aa406dcb8b6f0d316293638',
  'source_wav_sha256': '92bd9aaccbb61fa2e7d80f7d6eced55120c0721f812f2a37c66d972549bc2b34',
  'pcm_sha256': 'e7f41e97a7326f71061883c7c83f656062f98f1d90d8f361ae5e5032f835b058'},
 {'id': 'meli-accent-f02b-zh',
  'recording': 'F02B_man',
  'language': 'chinese',
  'start': 302.46693225015986,
  'end': 324.0,
  'audio_id': 1116033,
  'audio_bytes': 280651836,
  'annotation_id': 1116009,
  'annotation_sha256': 'efe4c4a33cae3ede3b4dabdef455bd67ed98b98e9f0043a22b322fb0b345849c',
  'reference_sha256': '9caab1b40a1409c9bfe61a4c421514cc916caa6f9fd331a86a9b7309a7285383',
  'upstream_md5': '28a898c09aaf53ac2f9809cf46494c2f',
  'source_pcm_sha256': '88e1e0dbf59bb0fd208599c70aa3c096d6f79644aad9dc5f1be9c120b473780b',
  'source_wav_sha256': 'c60a98dfca43a636c9c7833929f5c1008b32f4c93bcb87eea1f50ab4f9656596',
  'pcm_sha256': 'cd1eba9f714b4f5257ec906231e93de03e8b455cbe01e9385eba478c95d58970'},
 {'id': 'meli-accent-m01b-zh',
  'recording': 'M01B_man',
  'language': 'chinese',
  'start': 186.8392564181141,
  'end': 206.23164273561895,
  'audio_id': 1115898,
  'audio_bytes': 277665536,
  'annotation_id': 1115899,
  'annotation_sha256': '2a713ce015b6e416d3ef84711965d90c92741e8c6c350c3a9f08eb9dda5d84f8',
  'reference_sha256': '179c7973416342b537367dfc3c95e591b16bfa1c7aea4670fa21cb0909718667',
  'upstream_md5': 'e3340c2ffbec2b88c06cdbee935bd491',
  'source_pcm_sha256': 'c3a38cbb9f17b883b0133d5aef53bf150b4b439e791f01bbbb5616bdbcd94f6b',
  'source_wav_sha256': '6266341c656776f82be3157cbfe63ce987a9a69e83a4568e5bfe207358e9d2f2',
  'pcm_sha256': '21720d19fccf650d048ff897de6449a586646d30f9035eb50cebab6bd245b607'},
 {'id': 'meli-accent-f89a-en',
  'recording': 'F89A_eng',
  'language': 'english',
  'start': 120.72284473578226,
  'end': 147.6789489552296,
  'audio_id': 1115802,
  'audio_bytes': 197154340,
  'annotation_id': 1115833,
  'annotation_sha256': '6194265ec1f04552b52443250bac4eb407248529791620847283466d351aea87',
  'reference_sha256': '0be0906bd963c105bfc34c0b648afc081e2577333c7c7ccc0d627f2c680e7b19',
  'upstream_md5': 'd9bb6089d9ac357e1fd88adcd50da8ec',
  'source_pcm_sha256': '6cc93e94faa4a01baf87f0d739ffb5497978d843a83c9150d856549daf24c9c3',
  'source_wav_sha256': '62e4d6455b7cc7ac4adc27267cd11ea1fd5c3a4dd44c381774bd178f4b6356a1',
  'pcm_sha256': '7ea7ea047f677a2b200813cb9358d114f433b36f6abe6b7ee45aa1e40b6e8f81'})
ACCENT_SELECTION = {'initial_order': ['F02A_eng', 'M01A_eng', 'F02B_man', 'M01B_man'],
 'additional_recording': 'F89A_eng',
 'rule': 'Participants fixed before annotations/audio. Enumerate entire continuous answers bounded '
         'by interviewer turns in explicit Interview task. Reject whole blocks containing xxx, @ '
         'or [REDACTED]. Trim non-speech-only edge annotations. Take first answer lasting 18–40 '
         'seconds. Keep internal pauses and disfluencies. Never filter by RMS, sound quality, ASR '
         'output or performance.',
 'initial_frozen_before_audio_download_utc': '2026-10-14T07:37:47.468842+00:00',
 'additional_frozen_before_audio_download_utc': '2026-10-14T07:40:20.919010+00:00',
 'additional_reason': 'F02A original English case begins English at 3 and cannot be classified as '
                      'necessarily non-native from metadata. Append F89A (Mandarin age 0, English '
                      'age 8) as an unambiguous later-English learner; do not drop or replace '
                      'prior four cases. No ASR outputs consulted.'}

# Final two-speaker holdout, selected after the >30s duration-guard rule
# was fixed, without seeing these speakers' inference results.
ACCENT_FINAL_SPECS = ({'recording': 'F94A_eng',
  'start': 332.0182927729368,
  'end': 374.99190106798557,
  'audio_id': 1115800,
  'audio_bytes': 204706076,
  'annotation_id': 1115858,
  'annotation_sha256': '36d515896c14342427a298ae1784a69c852559e127debef4b856f681fb12fde7',
  'upstream_md5': 'aaae067903b3ecfaa45fd319ce0fc246',
  'id': 'meli-accent-final-f94a-en',
  'language': 'english',
  'reference_sha256': '4fead8a22913be34e434f7ff82eb695064a7251e51155e332fcf2e7cb6e0f818',
  'source_pcm_sha256': '5bd1525f6fb246d412c40980ff71e1278039b070047c9387688716bcbf332c8d',
  'source_wav_sha256': '17ccd8950734c6f8517c2826a5e4afa7d5cd714d3efce44beebcf53ee053ee8d',
  'pcm_sha256': '414551f75a9734f2749018fac35a12bcffee410739c6d4943f5da1d4af839666'},
 {'recording': 'M99A_eng',
  'start': 199.93480489777647,
  'end': 238.32363111692334,
  'audio_id': 1115805,
  'audio_bytes': 216893136,
  'annotation_id': 1115839,
  'annotation_sha256': '99328a97ed91833d60164e2f7b4fa569b12be5ab794dc612ed959291f0971d56',
  'upstream_md5': '5e73d79545acee1cff8ecefaae30548c',
  'id': 'meli-accent-final-m99a-en',
  'language': 'english',
  'reference_sha256': 'e175610eba7b76c5dbd9743268e817895cf63ee6cd58d21a86dad813155fe977',
  'source_pcm_sha256': '112f510e3463cf098de2f28b5880969391d95efb1f683e3bfa5fb2b8eb4c693c',
  'source_wav_sha256': '2634467eecb4a9c0b3df940a50cada3a7cd4375be3e5e273ef16f4964e5e41e3',
  'pcm_sha256': 'fb277033f17f14f3a1449b2d49da0b28b8042f431748145a51f991e16a6ed54a'})
ACCENT_FINAL_SELECTION = {'selection_order': ['F94A_eng', 'M99A_eng'],
 'rule': 'Choose unused participants with English starting age >=6 in original metadata row order. '
         'Within explicit Interview task enumerate complete continuous answer blocks bounded by '
         'interviewer turns; reject entire blocks with xxx, @ or [REDACTED]; trim non-speech-only '
         'edge annotations; take first answer lasting 30–45s. Keep internal pauses. Never read '
         'model outputs or select by RMS/audio quality. Do not replace prior samples.',
 'metadata_url': 'https://borealisdata.ca/api/access/datafile/1115395',
 'metadata_sha256': '9536bb11c1e17b75ca3fb2110cb653fd7c0c692bee5a1ec68b4a46ffacfb679d',
 'frozen_before_audio_download_utc': '2026-10-14T07:57:23.002795+00:00',
 'purpose': 'Final holdout for already proposed duration guard: shorten windows only when actual '
            'audio range exceeds 30s; ranges <=30s retain one window. No results or threshold '
            'tuning used in selection.'}

# Two new speakers reserved for a closed-text merging candidate, separate
# from the earlier duration-guard holdout. No reference text is stored here.
MERGE_HOLDOUT_SPECS = ({'recording': 'F95A_eng',
  'start': 1181.0242999510554,
  'end': 1221.4004798838896,
  'audio_id': 1115826,
  'audio_bytes': 305012540,
  'annotation_id': 1115797,
  'annotation_sha256': '1be821aca544341429726196c12db97d718375bdf204e73f11ee5e87f56e48c5',
  'upstream_md5': '4f73416d31130d06b0c83f91cc308273',
  'id': 'meli-merge-holdout-f95a-en',
  'language': 'english',
  'reference_sha256': '4ab8e76c7de69acc5ffcce205008a9de51718fa7e10f3691ec7997c98fe562ec',
  'source_pcm_sha256': '8feccf28f9bb7bfcfef85e71ba593882a1c2193dba2fe1676d5d9a9c0690e928',
  'source_wav_sha256': 'c76745da740c7c354b8009209220d3141ae594d076e07a33b8d1e577edf5feb0',
  'pcm_sha256': 'e0357297f32b954eb365ec0e3ce20a3f89147772114b358dd48ee0b5f921a659'},
 {'recording': 'F96A_eng',
  'start': 281.74797480907495,
  'end': 315.7377744305617,
  'audio_id': 1115791,
  'audio_bytes': 151689192,
  'annotation_id': 1115834,
  'annotation_sha256': 'ab9eafcb9832ab901eb83b7f99af6a669c9756f28daf538eef2f8bdc6750fb5a',
  'upstream_md5': '3e7786c565a0dccfcc700129e7cbce4b',
  'id': 'meli-merge-holdout-f96a-en',
  'language': 'english',
  'reference_sha256': '3f8ff57dd5e0c5d29856abe090b3e5fdbcc78ceb51932201a03a8ee16f3ddbb2',
  'source_pcm_sha256': 'bf8e0f2a4e50b297e222d1b5c8b3f46684983c703bd4f951aea427c7e748ba37',
  'source_wav_sha256': '8566d6940512d6aa7f9280da2bc40db05f5f7f9a09513c63ca6dbdc92b295c5c',
  'pcm_sha256': '7d2536772d60ef4037bdcc5ba8f200fdf5dea3cfa35c9cfa02c7ab3e3ff4be71'})
MERGE_HOLDOUT_SELECTION = {'selection_order': ['F95A_eng', 'F96A_eng'],
 'excluded_previous_participants': ['F00A',
                                    'F01A',
                                    'F01B',
                                    'F02A',
                                    'F02B',
                                    'F89A',
                                    'F94A',
                                    'M00A',
                                    'M00B',
                                    'M01A',
                                    'M01B',
                                    'M99A'],
 'frozen_before_annotations_utc': '2026-10-14T08:20:53.619759+00:00',
 'metadata_url': 'https://borealisdata.ca/api/access/datafile/1115395',
 'metadata_sha256': '9536bb11c1e17b75ca3fb2110cb653fd7c0c692bee5a1ec68b4a46ffacfb679d',
 'rule': 'First two unused participants in original metadata row order whose English starts at age '
         '>=6; first complete continuous answer of30–45s inside Interview, excluding entire '
         'answers with xxx/@/[REDACTED], trimming only nonspeech boundary annotations. Keep '
         'internal pauses, repetitions and disfluencies. Never select by RMS/audio quality/ASR '
         'output. No earlier case replacement.',
 'purpose': 'Independent validation of a closed-text window-merging candidate, not the earlier '
            'duration guard. No holdout output is used to choose or tune the repair.',
 'participant_freeze_sha256': '28784cd641b26beb5884be4d2623c583f53d846849e2e0d45dcdc4f942e88b78',
 'source_dataset_metadata_sha256': '46498479f724bc1d117dc51ab7a223cddcfa781e8580755eef13665738ef189e',
 'frozen_before_audio_download_utc': '2026-10-14T08:21:19.244752+00:00',
 'selection_file_sha256': 'ef98347cc7daf51a170013801c56bd5a2125372d25e13137001afe03a27784a5',
 'original_manifest_sha256': '7917753ec04a6e1ead6b7e12cf6a9dad3c91cbe633bdd7ceca9ce6fc8678331b'}

LANGUAGE_METADATA_ID = 1115395
LANGUAGE_METADATA_SHA256 = '9536bb11c1e17b75ca3fb2110cb653fd7c0c692bee5a1ec68b4a46ffacfb679d'


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


def accent_language_profiles(output, *, specs=ACCENT_SPECS, offline=False):
    """Read only the required public language-history fields from pinned metadata."""
    metadata_path = output / 'MELI_metadata_LBQ.tsv'
    if metadata_path.exists():
        data = verify(metadata_path.read_bytes(), LANGUAGE_METADATA_SHA256, str(metadata_path))
    else:
        require(not offline, f'Offline cache missing: {metadata_path}')
        data = verify(fetch(API + str(LANGUAGE_METADATA_ID), limit=1024 * 1024),
                      LANGUAGE_METADATA_SHA256, 'MELI language-background metadata')
        write_bytes(metadata_path, data)
    rows = list(csv.DictReader(data.decode('utf-8-sig').splitlines(), delimiter='\t'))
    fields = ('ID', 'Location_man', 'Location_eng', 'Language1', 'LanguageAge1', 'Speaking1',
              'Language2', 'LanguageAge2', 'Speaking2', 'Language3', 'LanguageAge3', 'Speaking3')
    profiles = {}
    for spec in specs:
        participant_id = spec['recording'].split('_')[0]
        matches = [row for row in rows if row.get('ID') == participant_id]
        require(len(matches) == 1, f'Missing or ambiguous language metadata: {participant_id}')
        require(all(field in matches[0] for field in fields), 'Language metadata schema changed')
        profiles[participant_id] = {field: matches[0][field] for field in fields}
    return profiles


def argument_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output-dir', type=Path, required=True, help='Local experiment directory outside the repository')
    presets = parser.add_mutually_exclusive_group()
    presets.add_argument('--merge-holdout', action='store_true', help='Prepare only two English closed-text merging holdouts; writes merge-holdout.local.json')
    presets.add_argument('--accent-final', action='store_true', help='Prepare only the two final English duration-guard holdouts; writes accent-final.local.json')
    presets.add_argument('--accent', action='store_true', help='Prepare only five new-speaker regional/bilingual interview cases; writes accent.local.json')
    presets.add_argument('--holdout', action='store_true', help='Prepare only the two new-participant Chinese holdouts; default is the original four cases')
    parser.add_argument('--offline', action='store_true', help='Verify/rebuild from cached TextGrids and source range WAVs; never access the network')
    parser.add_argument('--dry-run', action='store_true', help='Validate arguments and show fixed cases; no writes, downloads or NumPy/SciPy imports')
    return parser


def main(argv=None):
    parser = argument_parser()
    args = parser.parse_args(argv)
    output = args.output_dir.expanduser().resolve()
    if output == REPO_ROOT or REPO_ROOT in output.parents:
        parser.error('--output-dir must be outside the repository; media and reference data must not enter Git')
    if args.merge_holdout:
        specs, benchmark_version, manifest_name = (
            MERGE_HOLDOUT_SPECS, 'meli-merge-holdout-2026-10-14', 'merge-holdout.local.json')
    elif args.accent_final:
        specs, benchmark_version, manifest_name = (
            ACCENT_FINAL_SPECS, 'meli-accent-final-holdout-2026-10-14', 'accent-final.local.json')
    elif args.accent:
        specs, benchmark_version, manifest_name = (
            ACCENT_SPECS, 'meli-new-speaker-accent-2026-10-14', 'accent.local.json')
    elif args.holdout:
        specs, benchmark_version, manifest_name = (
            HOLDOUT_SPECS, 'meli-interviews-holdout-2026-10-14', 'holdout.local.json')
    else:
        specs, benchmark_version, manifest_name = (
            SPECS, 'meli-interviews-2026-10-14', 'cases.local.json')
    if args.dry_run:
        print(json.dumps(dict(output_dir=str(output), offline=args.offline,
                              cases=[dict(id=s['id'], language=s['language'], start=s['start'], end=s['end']) for s in specs]), indent=2))
        return 0
    output.mkdir(parents=True, exist_ok=True)
    profiles = accent_language_profiles(output, specs=specs, offline=args.offline) if (args.accent or args.accent_final or args.merge_holdout) else None
    cases = [prepare_case(s, output, offline=args.offline) for s in specs]
    if args.accent or args.accent_final or args.merge_holdout:
        for case in cases:
            case.update(language_background=profiles[case['participant_id']],
                        accent_strength='not independently audited',
                        language_metadata_source=API + str(LANGUAGE_METADATA_ID),
                        language_metadata_sha256=LANGUAGE_METADATA_SHA256)
            if args.accent_final:
                case['english_learning_start_age'] = 6
            if args.merge_holdout:
                profile = profiles[case['participant_id']]
                ages = [int(profile[f'LanguageAge{i}']) for i in range(1, 4)
                        if profile[f'Language{i}'] == 'English']
                require(len(ages) == 1, 'Missing or ambiguous English learning age')
                case['english_learning_start_age'] = ages[0]
    manifest = dict(schema_version=1, benchmark_version=benchmark_version,
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
    if args.accent:
        manifest['evaluation_role'] = 'development-diagnostic'
        manifest['selection'] = ACCENT_SELECTION
        manifest['notes'][0] = 'Five distinct participants absent from the previous six cases: three English and two Mandarin continuous interview answers.'
        manifest['notes'].extend([
            'Initial order F02A/M01A/F02B/M01B; F89A added only from language-history evidence, without replacing an earlier case.',
            'No selection by model output, recognition score, audio RMS or signal quality.',
            'These five cases later informed development/diagnosis; they are not untouched final holdouts for the duration guard.',
            'M01A and F89A report starting English at 13 and 8; F02A reports English at 3 and is an early bilingual learner.',
            'Henan/Xuzhou childhood language background does not establish an audible Mandarin accent severity. No heavy-accent-set claim.'
        ])
    if args.accent_final:
        manifest['evaluation_role'] = 'independent-holdout-after-duration-guard-freeze'
        manifest['selection'] = ACCENT_FINAL_SELECTION
        manifest['notes'][0] = 'Two unused English speakers F94A/M99A, with 42.973625s/38.388875s complete continuous interview answers.'
        manifest['notes'].extend([
            'Selected after the rule to shorten only actual audio ranges >30s was frozen, before these two inference outputs were examined.',
            'Both speakers report English onset at age 6. No selection by output, score, RMS or quality.',
            'Previous five accent cases served development/diagnosis; no previous case is replaced here.',
            'If future tuning uses these two results, they must no longer be claimed as untouched final holdouts.'
        ])
    if args.merge_holdout:
        manifest['evaluation_role'] = 'independent-holdout-for-closed-text-merging-candidate'
        manifest['selection'] = MERGE_HOLDOUT_SELECTION
        manifest['notes'][0] = 'Two unused English speakers F95A/F96A, with 40.3761875s/33.9898125s complete continuous interview answers.'
        manifest['notes'].extend([
            'Reserved for the closed-text merging candidate, not the earlier duration guard; no previous sample is replaced.',
            'F95A/F96A were chosen in fixed metadata row order, excluding all twelve previous participants; English starts at ages 6/12.',
            'The first eligible 30–45s continuous answer per speaker was selected before their inference outputs, without RMS or quality screening.',
            'Earlier five accent cases are development/diagnostic; the separate final two validated the duration guard only.',
            'References remain post-inference scoring inputs only. This preset does not establish that any recognition candidate passed.',
            'If later tuning uses these results, they can no longer be presented as untouched holdouts.'
        ])
    destination = output / manifest_name
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
