"use client";

import Image from "next/image";
import { useState } from "react";
import styles from "./InteractiveStreetlamp.module.css";

export function InteractiveStreetlamp() {
  const [isOn, setIsOn] = useState(false);

  return (
    <button
      type="button"
      className={styles.streetlamp}
      aria-label={isOn ? "Turn the streetlamp off" : "Turn the streetlamp on"}
      aria-pressed={isOn}
      onClick={() => setIsOn((current) => !current)}
    >
      <span className={styles.lampHalo} data-visible={isOn} aria-hidden="true" />
      <Image
        src="/streetlamp-off.svg"
        alt=""
        width={628}
        height={837}
        className={styles.lampImage}
        draggable={false}
        priority
      />
      <svg
        className={styles.lampLight}
        viewBox="0 0 628 837"
        data-visible={isOn}
        aria-hidden="true"
      >
        <defs>
          <radialGradient id="streetlamp-front-light" cx="46%" cy="43%" r="76%">
            <stop offset="0" stopColor="#faf2cf" />
            <stop offset="0.52" stopColor="#ecdaa2" />
            <stop offset="1" stopColor="#d7b85f" />
          </radialGradient>
          <linearGradient id="streetlamp-side-light" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#f1dfaa" />
            <stop offset="1" stopColor="#d9b95e" />
          </linearGradient>
        </defs>
        <path d="m241 119 100-2 1 32-100 2Z" fill="#edda9e" />
        <path
          d="M337 140c-.453 14.844-1.875 29.36-3.937 44.063l-.803 5.912c-1.165 8.542-2.391 17.062-3.86 25.558-.735 4.53-1.171 9.092-1.61 13.658-.415 3.873-1.013 6.254-2.79 9.809v-9h-3l1 1q.062 3.5 0 7h-9l4-1v-2l-7 1v2l-5 1v-5h15v-2l-15 1 1-2h3l-1-1-4 1v15h4v2h-31c-10.171-25.073-10.171-25.073-13.268-38.25-2.985-12.32-7.234-24.356-11.287-36.36-1.92-5.74-3.592-11.556-5.283-17.369l-.76-2.572-.672-2.302c-.738-2.17-1.688-4.11-2.73-6.147q11.438-.727 22.875-1.437l3.397-.212c13.75-.851 27.492-1.672 41.265-2.06 3.948-.116 7.823-.288 11.74-.81 4.934-.637 9.76-.543 14.723-.481"
          fill="url(#streetlamp-front-light)"
        />
        <path d="m350 123 40 11-5 28-35-10Z" fill="#e5ca82" />
        <path
          d="M353 141c11.598 2.138 22.755 5.478 34 9l-.734 2.316c-1.862 5.949-3.62 11.905-5.204 17.934-3.158 11.982-6.613 23.781-10.878 35.422-1.158 3.254-2.19 6.521-3.184 9.828-3.435 11.367-7.684 22.443-12 33.5q-3.97-.211-7.937-.437l-2.288-.12A196 196 0 0 1 339 248l-1-1c-.237-12.78 2.022-25.374 4.184-37.92 1.14-6.67 2.128-13.254 2.587-20.008C345 187 345 187 346 185c.158-1.768.276-3.54.375-5.312.332-4.44.98-8.56 2.063-12.875 1.506-6.056 2.287-12.057 2.915-18.253.555-5.376.555-5.376 1.647-7.56"
          fill="url(#streetlamp-side-light)"
        />
        <g opacity="0.72">
          <path
            fill="#aea78e"
            d="m298 170 2 1-1.242 1.355-1.633 1.833-1.617 1.792c-3.792 5.08-3.916 9.989-3.848 16.137.47 3.99 1.88 5.788 4.34 8.883l-1 3q-1.225-1.651-2.437-3.312l-1.372-1.864c-2.506-3.838-2.582-7.61-2.543-12.054.755-5.946 3.753-10.955 7.664-15.395Z"
          />
          <path
            fill="#898267"
            d="M303 211c2.654 2.477 4.812 4.534 6 8 .078 2.332.09 4.668 0 7l2-4 1 7h5v-12c2.113 3.17 2.253 3.996 2.188 7.625l-.02 2.414L319 229l-1 1c-1.853.072-3.708.084-5.562.063l-3.067-.028L307 230l-.113-2.195c-.385-5.651-.955-9.834-3.887-14.805Z"
          />
          <path
            fill="#beb69c"
            d="M327 207h2v5h-3c-2.882 2.19-3.959 4.58-5 8-.443 2.992-.75 5.986-1 9h-1c-1.604-9.955-1.604-9.955.625-13.812L322 213q1.327-1.644 2.625-3.312Z"
          />
          <path fill="#d3caac" d="M314 219h1l1 10h-3Z" />
        </g>
      </svg>
    </button>
  );
}
