from pathlib import Path
p=Path('HarmonyCodexRemote/entry/src/main/ets/pages/Index.ets')
s=p.read_text(encoding='utf-8')
s=s.replace("            .enabled(this.isLandscapeSessionLayout() || this.selectedSession !== null || this.isNewSessionDraft)\n",'')
s=s.replace("          if (description.length > 0) {\n          Text(description)\n            .fontSize(this.scaledFontSize(9))\n            .fontColor(this.themeColor('#68717D'))\n            .maxLines(1)\n            .textOverflow({ overflow: TextOverflow.Ellipsis })\n", "          if (description.length > 0) {\n            Text(description)\n              .fontSize(this.scaledFontSize(9))\n              .fontColor(this.themeColor('#68717D'))\n              .maxLines(1)\n              .textOverflow({ overflow: TextOverflow.Ellipsis })\n")
p.write_text(s,encoding='utf-8')
