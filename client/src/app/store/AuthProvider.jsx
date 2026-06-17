import { useEffect, useState } from "react";
import { AuthContext } from "@/shared/lib/auth";
import { login as loginApi, getUserById } from "@/shared/api";

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isLoading, setIsLoading] = useState(true);

  const initializeAuth = async () => {
    const storedUserId = localStorage.getItem("userId");

    if (!storedUserId || storedUserId === "undefined") {
      setIsLoading(false);
      return;
    }

    try {
      const userData = await getUserById(storedUserId);
      setUser(userData);
    } catch (error) {
      console.error("Failed to fetch user info:", error);
      localStorage.removeItem("userId");
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (credentials) => {
    try {
      const userData = await loginApi(credentials);
      const loggedInUser = userData.user;
      localStorage.setItem("userId", loggedInUser.userId);

      // Fetch complete user profile (including alarmCondition)
      const fullUserData = await getUserById(loggedInUser.userId);
      setUser(fullUserData);
    } catch (error) {
      console.error("Login failed:", error);
      throw error;
    }
  };

  const logout = () => {
    setUser(null);
    localStorage.removeItem("accessToken");
    localStorage.removeItem("userId");
  };

  const refreshUser = () => initializeAuth();

  useEffect(() => {
    initializeAuth();
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, isLoading, login, logout, refreshUser }}
    >
      {children}
    </AuthContext.Provider>
  );
};
