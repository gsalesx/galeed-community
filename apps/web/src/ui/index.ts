/** Barrel da fundação visual (S0). Re-exporta TODOS os componentes + tipos
 *  e injeta os CSS de tokens/base. Consumir SEMPRE via `import { ... } from "../ui"`. */
import "./tokens.css";
import "./base.css";

export { Seal } from "./Seal";
export type { SealProps, Selo } from "./Seal";

export { Markdown } from "./Markdown";

export { StatusChip } from "./StatusChip";
export type { StatusChipProps, StatusVariant } from "./StatusChip";

export { LockChip } from "./LockChip";
export type { LockChipProps, LockLevel } from "./LockChip";

export { Chip } from "./Chip";
export type { ChipProps } from "./Chip";

export { Card } from "./Card";
export type { CardProps } from "./Card";

export { KpiTile } from "./KpiTile";
export type { KpiTileProps } from "./KpiTile";

export { Button } from "./Button";
export type { ButtonProps } from "./Button";

export { SearchInput } from "./SearchInput";
export type { SearchInputProps } from "./SearchInput";

export { Dropzone } from "./Dropzone";
export type { DropzoneProps, DropzoneKind } from "./Dropzone";

export { Skeleton, Loading } from "./Skeleton";
export type { SkeletonProps, LoadingProps } from "./Skeleton";

export { Brand } from "./Brand";
export type { BrandProps } from "./Brand";

export { Icon } from "./Icon";
export type { IconProps, IconName } from "./Icon";

export { Modal } from "./Modal";
export type { ModalProps } from "./Modal";

export { Toast } from "./Toast";
export type { ToastProps, ToastTone } from "./Toast";
