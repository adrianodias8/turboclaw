import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";

interface QRDisplayProps {
  qr: string | null;
}

export function QRDisplay({ qr }: QRDisplayProps) {
  const [rendered, setRendered] = useState<string>("");

  useEffect(() => {
    if (!qr) {
      setRendered("");
      return;
    }

    // Use qrcode-terminal to render to string
    import("qrcode-terminal").then((mod) => {
      mod.generate(qr, { small: true }, (output: string) => {
        setRendered(output);
      });
    }).catch(() => {
      setRendered(`QR: ${qr.slice(0, 50)}...`);
    });
  }, [qr]);

  if (!qr) return null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold color="cyan">Scan QR with WhatsApp</Text>
      {rendered ? (
        <Text>{rendered}</Text>
      ) : (
        <Text dimColor>Generating QR code...</Text>
      )}
    </Box>
  );
}
