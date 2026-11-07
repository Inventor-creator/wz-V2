import { createContext, useContext, useState, useEffect, type ReactNode, type FC } from "react";
import api from "../api";

// This context tracks the "active entity" for multi-entity scoping and sends
// it as a request header to the backend on every request.
interface ActiveEntityContextType {
    activeEntityId: number | null;
    setActiveEntityId: (id: number | null) => void;
}

const ActiveEntityContext = createContext<ActiveEntityContextType | undefined>(undefined);

export const ActiveEntityProvider: FC<{ children: ReactNode }> = ({ children }) => {
    const [activeEntityId, setActiveEntityId] = useState<number | null>(null);

    useEffect(() => {
        if (activeEntityId) {
            api.defaults.headers.common["X-Gym-Id"] = activeEntityId.toString();
        } else {
            delete api.defaults.headers.common["X-Gym-Id"];
        }
    }, [activeEntityId]);

    return (
        <ActiveEntityContext.Provider value={{ activeEntityId, setActiveEntityId }}>
            {children}
        </ActiveEntityContext.Provider>
    );
};

export const useActiveEntity = () => {
    const context = useContext(ActiveEntityContext);
    if (context === undefined) {
        throw new Error("useActiveEntity must be used within an ActiveEntityProvider");
    }
    return context;
};
