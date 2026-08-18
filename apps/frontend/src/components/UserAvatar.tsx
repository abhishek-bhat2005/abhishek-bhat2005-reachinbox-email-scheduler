import { useState } from "react";

interface UserAvatarProps {
  avatarUrl: string | null;
  name: string;
}

export function UserAvatar({ avatarUrl, name }: UserAvatarProps) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = avatarUrl !== null && avatarUrl !== failedUrl;

  if (!showImage) {
    return (
      <span className="grid size-9 place-items-center rounded-full bg-indigo-100 text-sm font-bold text-indigo-700">
        {name.slice(0, 1).toUpperCase()}
      </span>
    );
  }

  return (
    <img
      alt=""
      className="size-9 rounded-full object-cover"
      onError={() => setFailedUrl(avatarUrl)}
      referrerPolicy="no-referrer"
      src={avatarUrl}
    />
  );
}
