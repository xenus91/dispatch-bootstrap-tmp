import { useEffect } from "react";
import { useLocation } from "wouter";
import { applyViewport, backButton, inMax, onBackButton } from "../lib/miniapp";

/**
 * Согласование панели с оболочкой MAX:
 *  - подгоняем высоту вьюпорта под клиент мессенджера;
 *  - на вложенных экранах показываем системную кнопку «Назад» и уводим её
 *    в историю браузера, чтобы жест/кнопка работали как внутри MAX.
 * Вне мини-приложения всё это — no-op.
 */
export function useMaxChrome() {
  const [path, navigate] = useLocation();

  useEffect(() => {
    if (!inMax()) return;
    void applyViewport();
  }, []);

  const nested = path !== "/" && path !== "/requests";

  useEffect(() => {
    if (!inMax()) return;
    backButton(nested);
    if (!nested) return;

    const off = onBackButton(() => {
      if (window.history.length > 1) window.history.back();
      else navigate("/requests");
    });
    return () => {
      off();
      backButton(false);
    };
  }, [nested, navigate]);
}
