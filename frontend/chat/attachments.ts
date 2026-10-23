import {SimpleImageAttachmentAdapter, type PendingAttachment} from "@assistant-ui/react";

export const imageTypes = "image/png,image/jpeg,image/gif,image/webp";
export const maxImageSize = 4 * 1024 * 1024;

export class ChatImageAttachmentAdapter extends SimpleImageAttachmentAdapter {
  override accept = imageTypes;

  override async add({file}: {file: File}): Promise<PendingAttachment> {
    if (!imageTypes.split(",").includes(file.type)) throw new Error("请选择 PNG、JPEG、GIF 或 WebP 图片");
    if (!file.size || file.size > maxImageSize) throw new Error("图片不能为空，且每张不能超过 4 MiB");
    return super.add({file});
  }
}

export function validateImages(images: readonly string[]) {
  if (images.length > 4) throw new Error("每条消息最多附加 4 张图片");
  let total = 0;
  for (const image of images) {
    const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2})$/.exec(image);
    if (!match || !match[1]) throw new Error("图片内容无效，请重新添加");
    const size = match[1].length * 3 / 4 - (match[1].endsWith("==") ? 2 : match[1].endsWith("=") ? 1 : 0);
    if (size > maxImageSize) throw new Error("每张图片不能超过 4 MiB");
    total += size;
  }
  if (total > 8 * 1024 * 1024) throw new Error("每条消息的图片总大小不能超过 8 MiB");
}
