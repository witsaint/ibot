import Image from "next/image";
import { StormCloud } from "./StormCloud";
import styles from "./SkyClouds.module.css";

export function SkyClouds() {
  return (
    <div className={styles.sky}>
      <Image
        src="/cloud-1.svg"
        alt=""
        width={628}
        height={312}
        className={`${styles.cloud} ${styles.cloudOne}`}
        sizes="(max-width: 760px) 36vw, 19vw"
        priority
        draggable={false}
      />
      <StormCloud className={`${styles.cloud} ${styles.cloudDark}`} />
      <Image
        src="/cloud-5.svg"
        alt=""
        width={628}
        height={262}
        className={`${styles.cloud} ${styles.cloudFive}`}
        sizes="(max-width: 760px) 32vw, 18vw"
        draggable={false}
      />
      <Image
        src="/cloud-2.svg"
        alt=""
        width={628}
        height={212}
        className={`${styles.cloud} ${styles.cloudTwo}`}
        sizes="(max-width: 760px) 40vw, 22vw"
        draggable={false}
      />
      <Image
        src="/cloud-2-1.svg"
        alt=""
        width={628}
        height={207}
        className={`${styles.cloud} ${styles.cloudTwoOne}`}
        sizes="(max-width: 760px) 38vw, 21vw"
        draggable={false}
      />
      <Image
        src="/cloud-4.svg"
        alt=""
        width={628}
        height={171}
        className={`${styles.cloud} ${styles.cloudFour}`}
        sizes="(max-width: 760px) 38vw, 20vw"
        draggable={false}
      />
      <Image
        src="/cloud-1.svg"
        alt=""
        width={628}
        height={312}
        className={`${styles.cloud} ${styles.cloudOneRight}`}
        sizes="(max-width: 760px) 21vw, 11vw"
        draggable={false}
      />
    </div>
  );
}
