# Светлая подложка DCL-832: мажор, 100 BPM, маримба, мягкая перкуссия. Синтез с нуля.
import numpy as np, subprocess, sys
sr = 44100
DUR = float(sys.argv[1]); out = sys.argv[2]
N = int(DUR * sr); t = np.arange(N) / sr
rng = np.random.default_rng(832)
BPM = 100; BEAT = 60 / BPM; BAR = 4 * BEAT

def hz(note):
    names = {'C': -9, 'C#': -8, 'D': -7, 'D#': -6, 'E': -5, 'F': -4, 'F#': -3, 'G': -2, 'G#': -1, 'A': 0, 'A#': 1, 'B': 2}
    return 440.0 * 2 ** ((names[note[:-1]] + 12 * (int(note[-1]) - 4)) / 12)

CH = {  # бас, затем ноты аккорда
    'C':  ['C2', 'E4', 'G4', 'C5', 'E5'], 'G':  ['G2', 'D4', 'G4', 'B4', 'D5'],
    'Am': ['A2', 'E4', 'A4', 'C5', 'E5'], 'F':  ['F2', 'C4', 'F4', 'A4', 'C5'],
    'Dm': ['D2', 'D4', 'F4', 'A4', 'D5'], 'Em': ['E2', 'E4', 'G4', 'B4', 'E5'],
}
# Разделы по таймингам озвучки (секунды)
SECT = [(0, 20.8, 'intro', ['C', 'G', 'Am', 'F']), (20.8, 34.2, 'problem', ['Am', 'F', 'C', 'G']),
        (34.2, 65.5, 'model', ['C', 'G', 'Am', 'F']), (65.5, 84.5, 'solution', ['F', 'G', 'C', 'Am']),
        (84.5, 98.5, 'result', ['Dm', 'F', 'G', 'G']), (98.5, DUR, 'final', ['C', 'G', 'Am', 'F'])]
INT = {  # интенсивность партий по разделам
    'intro':    dict(pad=.8, mar=.8, bass=.6, kick=.5, hat=.6, clap=0),
    'problem':  dict(pad=1., mar=.5, bass=.5, kick=0, hat=.4, clap=0),
    'model':    dict(pad=.8, mar=.9, bass=.9, kick=.8, hat=.8, clap=.3),
    'solution': dict(pad=.8, mar=1., bass=1., kick=1., hat=1., clap=.8),
    'result':   dict(pad=.9, mar=1., bass=1., kick=1., hat=1., clap=1.),
    'final':    dict(pad=1., mar=1., bass=1., kick=1., hat=1., clap=1.),
}
bars = []  # (start, chord, section)
for a, b, name, prog in SECT:
    s, i = a, 0
    while s < b - 0.05:
        bars.append((s, prog[i % len(prog)], name)); s += BAR; i += 1

mix = np.zeros((N, 2))
def add(sig, start, pan=0.0, gain=1.0):
    i0 = int(start * sr); i1 = min(N, i0 + len(sig))
    if i1 <= i0: return
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    mix[i0:i1, 0] += sig[:i1 - i0] * gain * l * 1.41
    mix[i0:i1, 1] += sig[:i1 - i0] * gain * r * 1.41

def marimba(f, dur=1.2):
    tt = np.arange(int(dur * sr)) / sr
    return (np.sin(2*np.pi*f*tt) * np.exp(-tt/0.45) + 0.35*np.sin(2*np.pi*f*3.9*tt) * np.exp(-tt/0.08)
            + 0.12*np.sin(2*np.pi*f*9.2*tt) * np.exp(-tt/0.03)) * np.clip(tt/0.003, 0, 1)
def kick():
    tt = np.arange(int(0.35*sr)) / sr
    f = 45 + 75*np.exp(-tt/0.04)
    return np.sin(2*np.pi*np.cumsum(f)/sr) * np.exp(-tt/0.13)
def hat(dec=0.035):
    n = rng.standard_normal(int(0.12*sr)); n = np.diff(n, prepend=0); n = np.diff(n, prepend=0)
    tt = np.arange(len(n)) / sr
    return n * np.exp(-tt/dec) * 0.25
def clap():
    n = rng.standard_normal(int(0.25*sr)); n = np.diff(n, prepend=0)
    tt = np.arange(len(n)) / sr
    env = np.exp(-tt/0.09) * (1 + 0.6*np.exp(-((tt-0.012)/0.004)**2) + 0.5*np.exp(-((tt-0.024)/0.004)**2))
    return n * env * 0.35
def pad_chord(notes, dur):
    tt = np.arange(int((dur + 1.5) * sr)) / sr
    env = np.clip(tt/0.6, 0, 1) * np.clip((dur + 1.5 - tt)/1.5, 0, 1)
    sig = sum(np.sin(2*np.pi*hz(n)/2*(1+d)*tt + h) / (1 + k*0.3)
              for k, n in enumerate(notes) for d, h in ((-0.0015, 0.0), (0.0015, 1.3)))
    return sig * env * 0.06
def bass_note(f, dur):
    tt = np.arange(int(dur*sr)) / sr
    return (np.sin(2*np.pi*f*tt) + 0.25*np.sin(4*np.pi*f*tt)) * np.clip(tt/0.005, 0, 1) * np.exp(-tt/0.35) * 0.5

ARP = [1, 2, 3, 4, 3, 2, 3, 4]   # индексы нот аккорда, восьмые
for bi, (s, c, name) in enumerate(bars):
    I = INT[name]; notes = CH[c]
    add(pad_chord(notes[1:], BAR), s, 0, I['pad'])
    for q in range(8):  # восьмые
        on = s + q * BEAT / 2
        if on >= DUR: break
        if I['mar'] and (q % 2 == 0 or rng.random() < 0.55 * I['mar']):
            f = hz(notes[ARP[q]]) * (2 if name in ('solution', 'final') and q in (3, 7) else 1)
            add(marimba(f), on, pan=0.35 if q % 2 else -0.35, gain=0.16 * I['mar'] * (0.75 + 0.25 * rng.random()))
        if I['bass'] and q in (0, 3, 4, 6):
            add(bass_note(hz(notes[0]) * (2 if q == 6 else 1), BEAT * 0.9), on, 0, 0.5 * I['bass'])
        if I['hat']:
            add(hat(0.05 if q % 2 else 0.03), on, 0.3, (0.18 if q % 2 else 0.1) * I['hat'])
        if I['kick'] and q in (0, 4) or (I['kick'] >= 1 and q == 5 and bi % 2):
            add(kick(), on, 0, 0.55 * I['kick'])
        if I['clap'] and q in (2, 6):
            add(clap(), on, -0.1, 0.5 * I['clap'])
    # нарастание перед финалом: дробь в последнем такте раздела «result»
    if name == 'result' and (bi + 1 == len(bars) or bars[bi + 1][2] != 'result'):
        for q in range(16):
            add(clap(), s + q * BEAT / 4, 0, 0.12 + 0.3 * q / 16)

# финальный аккорд
end_s = bars[-1][0] + BAR
if end_s < DUR:
    add(pad_chord(CH['C'][1:], DUR - end_s), end_s, 0, 1.0)
fade = (np.clip(t / 1.5, 0, 1) * np.clip((DUR - t) / 3.0, 0, 1))[:, None]
mix *= fade
mix /= np.abs(mix).max() + 1e-9
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'f32le', '-ar', str(sr), '-ac', '2', '-i', '-', out], input=mix.astype(np.float32).tobytes(), check=True)
print('bars', len(bars))
