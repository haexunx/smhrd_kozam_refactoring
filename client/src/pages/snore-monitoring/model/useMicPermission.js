import { useModal } from "@/shared/lib/modal";
import { checkMicPermission, requestMicPermission } from "@/shared/lib/audio";

export const useMicPermission = () => {
  const { openModal } = useModal();

  const handleMicPermission = async () => {
    const { state } = await checkMicPermission();

    if (state === "granted") {
      return true;
    }

    return new Promise((resolve) => {
      if (state === "prompt") {
        openModal({
          title: "마이크 권한 요청",
          description:
            "코골이 감지를 위해 마이크 권한이 필요해요.\n녹음 데이터는 저장되지 않고 분석에만 사용돼요.",
          onConfirm: async () => {
            const granted = await requestMicPermission();
            resolve(granted);
          },
          onCancel: () => resolve(false),
        });

        return;
      }

      if (state === "denied") {
        openModal({
          title: "마이크 권한 재설정 요청",
          description:
            "브라우저에서 마이크 권한을 다시 허용해야\n모니터링을 시작할 수 있어요.",
          onConfirm: () => resolve(false),
          showCancel: false,
        });

        return;
      }

      resolve(false);
    });
  };

  return {
    handleMicPermission,
  };
};
