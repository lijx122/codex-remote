---
name: codex-wechat-sendfile
description: Use when the user asks Codex or another agent to send a generated artifact, screenshot, PDF, document, image, video, or local file back to WeChat through CodexRemote.
---

# Codex WeChat Sendfile

Use this skill when the user asks for a result to be sent back to WeChat, for example:

- "跑起来给我看看效果，然后把产物发我一份"
- "截图发我"
- "把这个 PDF / 图片 / 视频 / 文档发到微信"
- "把刚才生成的文件发给我"

Do not guess whether every task needs file delivery. Only send a file when the user asks for it, or when the task explicitly produces a file that must be delivered.

## Delivery Rule

1. Generate or locate the final artifact on local disk.
2. If the artifact is a visual app or web page, create a screenshot first.
3. Send the final file through CodexRemote:

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:8787/sendfile" `
  -Method Post `
  -ContentType "application/json" `
  -Body (@{ path = "C:\absolute\path\to\artifact.png" } | ConvertTo-Json)
```

4. Report the local file path and whether the `/sendfile` request succeeded.

## Supported Files

CodexRemote routes common image and video extensions as WeChat media. Other files are sent as file attachments.

Good artifact formats:

- Images: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`
- Video: `.mp4`, `.mov`, `.webm`
- Documents: `.pdf`, `.docx`, `.txt`, `.md`
- Data: `.xlsx`, `.csv`, `.json`
- Bundles: `.zip`

## PowerShell Notes

Use `ConvertTo-Json` instead of hand-written JSON when the path may contain backslashes, spaces, or Chinese characters.

For a path stored in a variable:

```powershell
$file = "C:\absolute\path\to\artifact.pdf"
Invoke-RestMethod `
  -Uri "http://127.0.0.1:8787/sendfile" `
  -Method Post `
  -ContentType "application/json" `
  -Body (@{ path = $file } | ConvertTo-Json)
```

The receiver defaults to the latest WeChat conversation that sent a message to CodexRemote. Do not pass `toUserId` unless the user explicitly needs a non-default target.
