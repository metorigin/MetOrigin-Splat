import { useEffect, useRef, useState } from "react";

export function StatusAnnouncer({
  message,
  assertive = false,
}: {
  message: string;
  assertive?: boolean;
}) {
  const [announcedMessage, setAnnouncedMessage] = useState(message);
  const lastAnnouncement = useRef(`${assertive}:${message}`);

  useEffect(() => {
    if (!message) return;
    const announcementKey = `${assertive}:${message}`;
    if (announcementKey === lastAnnouncement.current) return;
    lastAnnouncement.current = announcementKey;
    setAnnouncedMessage(message);
  }, [assertive, message]);

  return (
    <div
      className="visually-hidden"
      role={assertive ? "alert" : "status"}
      aria-live={assertive ? "assertive" : "polite"}
      aria-atomic="true"
    >
      {announcedMessage}
    </div>
  );
}
