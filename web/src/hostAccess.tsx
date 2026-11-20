import React, { createContext, useContext, useMemo, useState } from "react";

interface HostAccess {
  /**
   * True when this browser runs on the machine hosting the backend. Remote
   * (LAN) clients get false: folder setup and "Reveal in Explorer" act on the
   * host's disk and desktop, so the server refuses them and the UI hides them.
   * Optimistic until the first /api/library answer.
   */
  isLocal: boolean;
  setIsLocal: (value: boolean) => void;
}

const HostAccessContext = createContext<HostAccess>({
  isLocal: true,
  setIsLocal: () => {},
});

export const HostAccessProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [isLocal, setIsLocal] = useState<boolean>(true);
  const value = useMemo(() => ({ isLocal, setIsLocal }), [isLocal]);
  return (
    <HostAccessContext.Provider value={value}>
      {children}
    </HostAccessContext.Provider>
  );
};

export function useHostAccess(): HostAccess {
  return useContext(HostAccessContext);
}
