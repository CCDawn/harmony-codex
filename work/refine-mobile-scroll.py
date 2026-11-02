from pathlib import Path
for name in ('SettingsPanel','PairingPanel'):
 p=Path(f'HarmonyCodexRemote/entry/src/main/ets/components/{name}.ets')
 s=p.read_text(encoding='utf-8').replace("}.width('100%').layoutWeight(1).scrollBar(BarState.Auto)","}.width('100%').layoutWeight(1).align(Alignment.TopStart).scrollBar(BarState.Auto)")
 p.write_text(s,encoding='utf-8')
